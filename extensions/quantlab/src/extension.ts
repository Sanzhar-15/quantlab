/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { registerDataCommands } from './commands/dataCommands';
import { registerWatchlistCommands } from './commands/watchlistCommands';
import { registerQuantbookCommands } from './commands/quantbookCommands';
import { CellGridPanel } from './quantbook/cellGrid/cellGridPanel';
import { QbookEditorProvider } from './quantbook/cellGrid/qbookEditorProvider';
import { QuantbookDiagnostics, QUANTBOOK_DIAGNOSTICS_SCHEME } from './quantbook/diagnostics/quantbookDiagnostics';
import { registerReactiveKernelCommands, setReactiveDiagnosticsSink } from './quantbook/reactiveKernel/reactiveKernelCommands';
import type { ReactiveKernelManager } from './quantbook/reactiveKernel/reactiveKernelManager';
import { QNB_NOTEBOOK_TYPE, QnbSerializer } from './quantbook/reactiveNotebook/qnbSerializer';
import { registerReactiveNotebookController } from './quantbook/reactiveNotebook/reactiveNotebookController';
import { registerQuantbookShell } from './quantbook/shell/quantbookShell';
import { registerDepGraphSidebar } from './quantbook/shell/registerDepGraphSidebar';
import { registerDiagnosticsView } from './quantbook/shell/registerDiagnosticsView';
import { registerFunctionCatalogView } from './quantbook/shell/registerFunctionCatalogView';
import { SqlQueryViewProvider } from './quantbook/shell/SqlQueryViewProvider';
import { registerQuantbookMcpServer } from './quantbook/mcp/mcpServer';
import type { SessionInstance } from './quantbook/types';
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
import { VisualiseDataProvider } from './views/visualise/VisualiseDataProvider';
import { VisualiseSpecProvider } from './views/visualise/VisualiseSpecProvider';
import {
	DaemonLifecycle,
	DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
} from './qviz/daemon-lifecycle';
import { resolveQuantlabPython, verifyPythonVersion } from './qviz/pythonPath';
import { LifecycleManager } from './qviz/lifecycleManager';
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
import { DataViewManager } from './views/DataViewManager';
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
	// panel directly -- no intermediate quick-pick step for the user.
	// If the welcome panel is already open it just reveals it rather than opening a second modal.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.signIn', async () => {
			try {
				await authProvider.createSession(['read']);
			} catch (err) {
				// ERR_CANCELLED = user closed the panel -- no notification needed.
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
	// Megaudit M87 (No-Fallbacks): a failed reconnect silently kills all
	// real-time feeds while the UI shows a signed-in state -- log it.
	context.subscriptions.push(
		authProvider.onDidChangeSessions(e => {
			if (e.added && e.added.length > 0) {
				void serverClient.connectWebSocket().catch(err => {
					getServerOutputChannel().appendLine(
						`[extension] WebSocket reconnect after sign-in failed: ${err instanceof Error ? err.message : String(err)}`
					);
				});
			}
		})
	);

	// Status bar account item -- one-click access to sign in / sign out.
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
				`**Quantlab** \u00B7 ${user.tier} tier\n\n${user.email}\n\n[Sign Out](command:quantlab.signOut)`,
				true
			);
			accountStatusItem.command = 'quantlab.signOut';
		} else {
			accountStatusItem.text = `$(account) Sign In`;
			accountStatusItem.tooltip = 'Sign in to Quantlab';
			accountStatusItem.command = 'quantlab.signIn';
		}
		// Only show the item once auth state is known (prevents "Sign In" flash on startup).
		if (_authStateResolved) {
			accountStatusItem.show();
		}
	};

	// Show QuantLab Home dashboard after each active sign-in.
	// Not shown during startup session restore -- only when the user actively signs in.
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
			} else if (!user) {
				// Sign-out: re-arm the auto-show so the NEXT sign-in gets a
				// fresh Home (the panel itself disposes on sign-out; without
				// this reset it would never auto-reopen in the same session).
				_homeShownThisSession = false;
			}
		})
	);
	updateAccountStatus();

	// Register home command so it can always be re-opened from command palette.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openHome', () => {
			const user = serverClient.getUser();
			if (!user) {
				void vscode.window.showInformationMessage('Sign in to Quantlab to view your dashboard.');
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
	context.subscriptions.push(VisualiseDataProvider.register(context));
	qvizLifecycleManager = createQvizLifecycleManager(context);
	context.subscriptions.push(VisualiseSpecProvider.register(context, {
		lifecycleSource: qvizLifecycleManager,
	}));

	// Wave H2 (R10 part 2/2, 2026-06-19): the `.qbook` custom editor -- double-clicking a
	// single-file `.qbook` in the Explorer opens the live cell grid with a dirty tab, Ctrl+S,
	// Save As, revert, and hot-exit. Additive to the command-driven grid (the demo + Open/Save-As
	// commands are unchanged); the workbook model lives in the owning engine Session.
	context.subscriptions.push(QbookEditorProvider.register(context));

	// Visualise v2 -- Promote to Chart. The webview button is the primary
	// entry point (posts a `promoteToChart` message to the provider); this
	// command-palette entry gives a discoverable fallback that surfaces a
	// helpful message when no Visualise spec editor is active. (The
	// active-panel forwarding path is a future enhancement; v1 wires
	// through the webview only.)
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.visualise.promoteToChart', () => {
			void vscode.window.showInformationMessage(
				'Promote to Chart: open a .qviz.json spec and click the "Promote to Chart" button in the editor header.',
			);
		}),
	);

	// Megaudit-2 A4-M5: when the user edits `quantlab.pythonPath` or
	// `python.defaultInterpreterPath`, drop the per-folder
	// `DaemonLifecycle` cache so the next document access re-runs the
	// factory (which re-reads config and re-validates the binary via
	// `verifyPythonVersion`). Without this, a respawn after crash --
	// or a future doc open in the same workspace folder -- would use
	// the previously-validated python path even though the user just
	// changed it to a different interpreter (possibly Python 2.x).
	context.subscriptions.push(
		vscode.workspace.onDidChangeConfiguration((evt) => {
			const affected = (
				evt.affectsConfiguration('quantlab.pythonPath')
				|| evt.affectsConfiguration('python.defaultInterpreterPath')
			);
			if (!affected) { return; }
			const mgr = qvizLifecycleManager;
			if (mgr === null) { return; }
			// Fire-and-forget: child SIGTERM grace is async, but the
			// cache clear is synchronous so a follow-up open will
			// rebuild lifecycles immediately. Errors propagate to
			// the unhandledRejection logger; we do NOT swallow.
			void mgr.invalidate();
		}),
	);

	registerDataCommands(context);
	// W1.3 (megaudit H1): watchlist CRUD commands for the Data tree context menus.
	registerWatchlistCommands(context, watchlistManager);
	registerGlobalStateCommands(context);
	registerHistoryCommands(context);
	registerPanelCommands(context);
	registerTradeCommands(context);
	registerViewCommands(context);
	registerDashboardCommands(context);
	// Phase 5.7 V1 (2026-05-22): Quantbook engine demo round-trip.
	registerQuantbookCommands(context);
	// FE-1.5-1d-1: the reactive-kernel commands. Trust MUST be initialized first -- nothing called
	// TrustManager.initialize before (so the trust store never loaded); the kernel's trust gate
	// depends on it. Fail-closed: if init throws, the store stays empty -> the kernel refuses to
	// spawn (the safe direction), never a silent ungated spawn.
	let reactiveTrustReady = false;
	try {
		await TrustManager.getInstance().initialize(context);
		reactiveTrustReady = true;
	} catch (e) {
		console.warn('Quantlab: TrustManager.initialize failed; the reactive kernel will treat the workspace as untrusted:', e);
	}
	// Pass a getter (not the bool) so the gate reads the final value even though init is awaited above.
	const builtKernelManager = registerReactiveKernelCommands(context, () => reactiveTrustReady);
	reactiveKernelManager = builtKernelManager;

	// FE-1.5 W-N: the `.qnb` reactive-notebook serializer (the controller is registered in N-1).
	// Outputs are transient (the kernel re-runs), so they are never written to disk.
	context.subscriptions.push(
		vscode.workspace.registerNotebookSerializer(QNB_NOTEBOOK_TYPE, new QnbSerializer(), { transientOutputs: true }),
	);
	// FE-1.5 W-N (N-1): the NotebookController that runs `.qnb` Python cells against the focused grid's
	// reactive kernel (bind-on-first-execute, serialized, lifetime-safe). Built after the manager exists.
	registerReactiveNotebookController(context, builtKernelManager);

	// FE-BEYOND B1 (W3): the read-only Quantbook MCP server. Runs IN this host so its tools read the
	// SAME live per-panel Session the grid renders (the shared-state requirement). Registered AFTER the
	// reactive notebook controller (W3 anchor; W4/FE-5 uses the later panel-providers anchor) so the two
	// parallel windows never edit overlapping lines here.
	registerQuantbookMcpServer(context, builtKernelManager);

	// Megaudit H2: the provider was constructed and discarded, so its dispose()
	// (which tears down the DataTreeProvider's three event subs + retry timer)
	// never ran. Owned by context.subscriptions now.
	context.subscriptions.push(new DataPanelProvider(context, globalState, watchlistManager));
	const catalogService = ResourcesCatalogService.initialize(context);
	const resourcesProvider = ResourcesWebviewProvider.initialize(context.extensionUri, catalogService);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(ResourcesWebviewProvider.viewType, resourcesProvider)
	);

	// Non-blocking catalog pre-fetch. Megaudit M88 (No-Fallbacks): the failure
	// must be logged -- cached/offline data is still used on first panel open,
	// and the Resources panel surfaces its own error state, but the root cause
	// must not vanish.
	void catalogService.getCatalog().catch(err => {
		getServerOutputChannel().appendLine(
			`[extension] Resources catalog prefetch failed: ${err instanceof Error ? err.message : String(err)}`
		);
	});
	new HistoryPanelProvider(context, historyState);
	new TradePanelProvider(context, badgeManager);
	new SettingsPanelProvider(context);

	// FE-5 (W4 product shell): the Quantbook Activity Bar surface (Live-Python sidebar + the
	// `quantbook.hasOpenGrid` context key gating the quantbook views). Registered AFTER the panel
	// providers + AFTER the reactive-kernel manager exists (the sidebar's data source).
	registerQuantbookShell(context, builtKernelManager);

	// W3 B3: the dependency-graph "Dependencies" sidebar -- shows the focused cell's cross-language
	// dependencies (formula precedents + the reactive Python variable driving it). Registered AFTER the
	// shell (which drives the `quantbook.hasOpenGrid` context key gating both quantbook views) and shares
	// the same reactive-kernel manager data source. Kept as a separate registration (not folded into
	// registerQuantbookShell) so the W3 increment is additive.
	registerDepGraphSidebar(context, builtKernelManager);

	// FE-6 / R18 Wave E: the "SQL Query" sidebar -- an in-session re-runnable SQL editor over the engine's
	// materializeQuery, spilling a SELECT into a target range on the focused grid. A WebviewViewProvider (not
	// a tree -- the SQL editor is multi-line), gated by the same `quantbook.hasOpenGrid` context key. Pure-IDE
	// (the napi is already in the loaded dylib). retainContextWhenHidden keeps the SQL draft across hide/show.
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(
			SqlQueryViewProvider.viewType,
			new SqlQueryViewProvider(context.extensionUri),
			{ webviewOptions: { retainContextWhenHidden: true } },
		),
	);

	// W2 error-surface: the dedicated Quantbook error surface -- ONE `quantbook` DiagnosticCollection that
	// mirrors cell errors into VS Code's Problems panel. The Cell Grid panel reports its stored cell errors
	// (each render's diagnostic-decorated snapshot) + input rejections (errorReply), and the reactive layer
	// reports workbook-level reactive errors; the bridge auto-clears on recovery (No-Fallbacks). The
	// `quantbook://` TextDocumentContentProvider serves a readable virtual doc per uri so a Problems-panel
	// click opens a real document. Injected via static sinks (mirrors setPublishedCellsProvider), cleared on
	// deactivate. Registered AFTER the reactive-kernel manager + the panel registry exist.
	const quantbookDiagnostics = new QuantbookDiagnostics();
	context.subscriptions.push(quantbookDiagnostics);
	context.subscriptions.push(
		vscode.workspace.registerTextDocumentContentProvider(QUANTBOOK_DIAGNOSTICS_SCHEME, quantbookDiagnostics),
	);
	CellGridPanel.setDiagnosticsSink(quantbookDiagnostics);
	context.subscriptions.push({ dispose: () => CellGridPanel.setDiagnosticsSink(undefined) });
	setReactiveDiagnosticsSink(quantbookDiagnostics);
	context.subscriptions.push({ dispose: () => setReactiveDiagnosticsSink(undefined) });

	// Wave I (R13 + R14, 2026-06-19): the "Errors" diagnostics sidebar -- a dedicated tree view over the
	// SAME diagnostics the Problems panel mirrors (grouped by sheet, error-class icons, full traceback in
	// the tooltip, click-to-reveal). Additive; reads quantbookDiagnostics' read API + refreshes on its
	// onDidChange. Registered AFTER the diagnostics bridge exists.
	registerDiagnosticsView(context, quantbookDiagnostics);

	// Wave I-b (R12, 2026-06-19): the "Functions" catalog sidebar -- a browsable tree of the focused
	// workbook's registered functions (built-ins grouped by letter + any UDFs), click-to-copy the name.
	// Additive; reads session.listFunctions() off the focused grid. Also serves the R22 catalog-UI tail.
	registerFunctionCatalogView(context);

	const validationTimers = new Map<string, ReturnType<typeof setTimeout>>();
	moduleValidationTimers = validationTimers;

	// Megaudit H49: quantlab.isDataFile was set to true by
	// DataViewManager.updateContextKeys() when a data view opened but NEVER
	// cleared when the user activated a non-data tab. Stale true + a Python
	// editor (editorTextFocus) made the two `ctrl+q e` keybindings
	// (quantlab.switchToEditor / quantlab.switchToDataEditor) BOTH fire.
	// Refresh the key on every active editor/tab change, in all three branches.
	// DataViewManager.getDataFileType is the single source of truth for what
	// counts as a data file.
	const updateDataFileContext = (resource?: vscode.Uri): void => {
		const fileType = resource ? DataViewManager.getInstance().getDataFileType(resource) : null;
		void vscode.commands.executeCommand('setContext', 'quantlab.isDataFile', Boolean(fileType));
		void vscode.commands.executeCommand('setContext', 'quantlab.dataFileType', fileType);
	};

	const updateActiveContext = async (editor?: vscode.TextEditor): Promise<void> => {
		if (editor) {
			updateDataFileContext(editor.document.uri);
			const view = stateManager.getCurrentViewForEditor(editor);
			const validation = validator.getValidationResult(editor.document) ?? validator.validateDocument(editor.document);
			updateContextKeys(view, validation);
			return;
		}

		const resource = getActiveResource();
		updateDataFileContext(resource);
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
				// Quick liveness probe: check if socket file exists and is a socket.
				// Megaudit M93 (No-Fallbacks): fs.Stats.isSocket() is always present
				// in Node.js -- no optional-chaining fallback that would silently
				// classify an un-probeable socket as absent.
				const stat = await fs.promises.stat(sockPath);
				if (stat.isSocket()) {
					aliveSessions.push(sessionId);
				}
			} catch {
				// Socket file doesn't exist or inaccessible -- stale, clean up
				try {
					await fs.promises.unlink(sockPath);
				} catch { /* ignore */ }
			}
		}

		if (aliveSessions.length === 0) {
			return;
		}

		// Megaudit M89: do NOT offer a 'Reconnect' button that immediately answers
		// 'not yet supported' -- only the two options that actually work.
		const action = await vscode.window.showWarningMessage(
			`Found ${aliveSessions.length} running daemon session(s) from a previous instance: ${aliveSessions.join(', ')}`,
			'Stop All', 'Ignore'
		);

		if (action === 'Stop All') {
			for (const sessionId of aliveSessions) {
				try {
					const sockPath = path.join(sessionsDir, `${sessionId}.sock`);
					await fs.promises.unlink(sockPath);
				} catch { /* best effort */ }
			}
		}
		// 'Ignore' -- do nothing
	} catch {
		// Sessions directory doesn't exist -- no orphans
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
					output.appendLine(`[${new Date().toISOString()}] Delta Plus: Session expired -- sign in again via the account menu`);
				}
			} else {
				output.appendLine(`[${new Date().toISOString()}] Delta Plus: Session restored -- user signed in`);
			}
		} else {
			output.appendLine(`[${new Date().toISOString()}] Delta Plus: No saved session -- sign in via the account menu`);
		}
	} catch (err) {
		output.appendLine(
			`[${new Date().toISOString()}] Delta Plus: Auth init error -- ${err instanceof Error ? err.message : String(err)}`
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
 * Module-level reference so `deactivate()` can await final disposal.
 * `context.subscriptions.push` would call `dispose()` synchronously
 * and not wait for the daemon child processes to exit (Step B AF6 + Step
 * C megaudit C1 regression -- fixed by awaiting in deactivate).
 */
let qvizLifecycleManager: LifecycleManager | null = null;
// FE-1.5-1d-1: reactive-kernel manager; disposed (awaited) in deactivate so no ipykernel is orphaned.
let reactiveKernelManager: ReactiveKernelManager<SessionInstance> | null = null;

/**
 * Wire the qviz daemon lifecycle MANAGER. The manager creates one
 * `DaemonLifecycle` per workspace folder lazily on first use, so a
 * multi-folder workspace gets per-folder daemons (Step C megaudit C12).
 *
 * Returns a manager whose `getLifecycleForDocument` may itself return
 * null if Python isn't available -- the spec editor still opens in that
 * case but save will REFUSE (Step C megaudit C5 enforcement).
 */
function createQvizLifecycleManager(
	context: vscode.ExtensionContext,
): LifecycleManager {
	const pythonPathPrefix = [
		vscode.Uri.joinPath(context.extensionUri, 'python').fsPath,
	];

	return new LifecycleManager({
		create(workspaceRoot: string): DaemonLifecycle | null {
			// Megaudit-2 A4-M5: read the configs FRESH inside `create()`
			// (not at activation time). The manager's `invalidate()` is
			// wired to `onDidChangeConfiguration`, which drops all
			// cached lifecycles and forces this factory to re-run --
			// at which point we MUST re-read the user's possibly-new
			// `quantlab.pythonPath` / `python.defaultInterpreterPath`
			// and re-validate via `verifyPythonVersion` below.
			const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
			const pythonExtConfig = vscode.workspace.getConfiguration('python');
			const resolved = resolveQuantlabPython({
				quantlabConfigPath: quantlabConfig.get<string>('pythonPath'),
				pythonExtConfigPath: pythonExtConfig.get<string>('defaultInterpreterPath'),
			});
			if (!resolved) {
				console.warn(
					'Quantlab: no Python interpreter found for qviz daemon '
					+ '(checked QUANTLAB_PYTHON, quantlab.pythonPath, '
					+ 'python.defaultInterpreterPath, ~/.quantlab/venv/bin/python). '
					+ 'Save will refuse for files in this workspace.',
				);
				return null;
			}
			// Megaudit MAJOR-42: verify the resolved binary is actually
			// Python >= 3.10 BEFORE spawning the daemon. The previous
			// code spawned blindly; if the user's
			// `python.defaultInterpreterPath` pointed at a non-Python
			// binary or Python 2.7, the daemon would crash at first
			// import with confusing error. Now we fail loudly with a
			// clear message identifying the configured path.
			const versionCheck = verifyPythonVersion(resolved.pythonPath, 3, 10);
			if (!versionCheck.ok) {
				console.warn(
					`Quantlab: Python at ${resolved.pythonPath} (source: ${resolved.source}) `
					+ `failed version check: ${versionCheck.error}. `
					+ 'Save will refuse for files in this workspace until a Python >=3.10 is configured.',
				);
				void vscode.window.showErrorMessage(
					`Quantlab: configured Python (${resolved.pythonPath}) is not usable: ${versionCheck.error}`,
				);
				return null;
			}
			console.info(
				`Quantlab: qviz daemon lifecycle for ${workspaceRoot} `
				+ `(source: ${resolved.source}, version ${versionCheck.version})`,
			);
			return new DaemonLifecycle({
				...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
				workspaceRoot,
				pythonPath: resolved.pythonPath,
				pythonPathPrefix,
			});
		},
	});
}

/**
 * Deactivates the Quantlab extension.
 */
export async function deactivate(): Promise<void> {
	// Step C megaudit C1: await qviz daemon lifecycle disposal explicitly.
	// `context.subscriptions.push({ dispose: () => lifecycle.dispose() })`
	// would not await the returned Promise (VS Code's contract for
	// synchronous disposables), leaving Python child processes running
	// past extension shutdown. Awaiting here guarantees clean teardown.
	if (qvizLifecycleManager !== null) {
		try {
			await qvizLifecycleManager.disposeAll();
		} catch (e) {
			console.warn('Quantlab: qviz lifecycle dispose threw during deactivate:', e);
		}
		qvizLifecycleManager = null;
	}

	// FE-1.5-1d-1: await the reactive-kernel teardown (SIGTERM-grace per supervisor) so no ipykernel
	// is orphaned past extension shutdown -- same reason the qviz lifecycle is awaited here.
	if (reactiveKernelManager !== null) {
		try {
			await reactiveKernelManager.disposeAll();
		} catch (e) {
			console.warn('Quantlab: reactive kernel dispose threw during deactivate:', e);
		}
		reactiveKernelManager = null;
	}

	// Cleanup server connection. Megaudit H50: dispose() alone leaves the
	// DISPOSED singleton cached on ServerApiClient.instance, so the next
	// activate() on hot reload reuses a dead client for every auth/WS call.
	// resetInstance() disposes AND nulls the instance so activate() builds a
	// fresh one.
	try {
		ServerApiClient.resetInstance();
	} catch (e) {
		console.warn('Quantlab: ServerApiClient reset threw during deactivate:', e);
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
