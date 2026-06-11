/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { ComplexityAnalyzer } from '../../core/strategy/ComplexityAnalyzer';
import { ParameterExtractor } from '../../core/strategy/ParameterExtractor';
import { VisualizationDetector } from '../../core/strategy/VisualizationDetector';
import { GlobalState } from '../../core/state/GlobalState';
import { HistoryState } from '../../core/state/HistoryState';
import { TabViewStateManager } from '../../core/state/TabViewState';
import { DataService } from '../../core/engine/DataService';
import { VisualizationRunner } from '../../core/engine/VisualizationRunner';
import { encodeOhlcvBars } from '../../utils/binaryTransfer';
import { applyParameterOverrides } from '../../utils/applyToCode';
import { debounce } from '../../utils/debounce';
import { getVisualizationTemplate } from '../../utils/visualizationTemplate';
import { ChartInboundMessage, ChartToolbarState, EquityPoint, OhlcvBar, SignalMarker } from '../../types/chart';
import { DataSourceDescriptor, Timeframe, isLocalFileSource, isServerSource, ServerDataSource } from '../../types/market';
import { ChartStateStore } from './ChartStateStore';
import { ChartWebview } from './ChartWebview';
import { TradeOverlayManager } from './TradeOverlayManager';
import { SessionManager } from '../../core/trading/SessionManager';
import { ThemeProvider } from '../../ui/tokens/ThemeProvider';
import { ReducedMotion } from '../../ui/accessibility/ReducedMotion';
import { FeatureDiscovery } from '../../ui/onboarding/FeatureDiscovery';

type BannerKind = 'viewOnly' | 'run' | 'data';

interface BannerMessage {
	message: string;
	tone?: 'info' | 'warning';
}

interface BannerState {
	viewOnly?: BannerMessage;
	run?: BannerMessage;
	data?: BannerMessage;
}

interface ChartSession {
	key: string;
	tabInstanceId?: string;
	document: vscode.TextDocument;
	panel: vscode.WebviewPanel;
	webview: ChartWebview;
	disposables: vscode.Disposable[];
	analysisDebounced: () => void;
	visualizationDebounced: () => void;
	cancellationTokenSource?: vscode.CancellationTokenSource;
}

/**
 * ChartViewProvider manages chart visualization for strategy files.
 *
 * STATE MANAGEMENT ARCHITECTURE:
 * - GlobalState: Workspace-wide defaults (dataSource, timeframe, dateRange)
 * - TabViewStateManager: Per-tab overrides and view-specific state
 *
 * PATTERN: ChartState stores ONLY overrides, not default values.
 * When reading state, always use fallback pattern:
 *   const value = chartState?.field ?? globalState.getField()
 *
 * When setting state:
 * - Global actions (file picker, data panel selection) → set GlobalState only
 * - Tab-specific overrides → set ChartState only
 * - refreshFromGlobal() propagates global changes to tabs without overrides
 */
export class ChartViewProvider implements vscode.CustomTextEditorProvider {
	static readonly viewType = 'quantlab.chartView';
	private static instance: ChartViewProvider | undefined;

	private readonly stateManager = TabViewStateManager.getInstance();
	private readonly parameterExtractor = ParameterExtractor.getInstance();
	// Cache size limits (prevent unbounded growth)
	private static readonly MAX_DATA_CACHE_SIZE = 50;
	private static readonly MAX_ARTIFACT_CACHE_SIZE = 30;

	private readonly visualizationDetector = VisualizationDetector.getInstance();
	private readonly complexityAnalyzer = ComplexityAnalyzer.getInstance();

	// Last visualization issues notified per session key. Visualization re-runs on every
	// parameter tweak/refresh, so identical issues must not re-toast each run.
	private readonly lastNotifiedVizIssues = new Map<string, string>();
	private readonly dataService = DataService.getInstance();
	private readonly visualizationRunner = VisualizationRunner.getInstance();
	private readonly chartStateStore = ChartStateStore.getInstance();
	private readonly dataCache = new Map<string, OhlcvBar[]>();
	private readonly dataCacheAccessTimes = new Map<string, number>(); // LRU tracking
	private readonly artifactCache = new Map<string, { signals?: SignalMarker[]; equity?: EquityPoint[] }>();
	private readonly artifactCacheAccessTimes = new Map<string, number>(); // LRU tracking
	private readonly sessions = new Map<string, ChartSession>();
	private readonly pendingRunByUri = new Map<string, string>();
	private readonly pendingLiveByUri = new Map<string, string>();
	private readonly liveSessions = new Map<string, { sessionId: string; previous?: { symbol?: string; timeframe?: Timeframe } }>();
	private readonly tradeOverlayManager = new TradeOverlayManager();
	private readonly sessionManager = SessionManager.getInstance();
	private readonly themeProvider = ThemeProvider.getInstance();
	private readonly reducedMotion = ReducedMotion.getInstance();
	private readonly bannerState = new Map<string, BannerState>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly globalState: GlobalState,
		private readonly historyState: HistoryState
	) {
		ChartViewProvider.instance = this;
		context.subscriptions.push(
			vscode.window.onDidChangeActiveColorTheme(() => this.broadcastTheme()),
			this.globalState.onDidChangeDataSource(() => this.refreshFromGlobal('dataSource')),
			this.globalState.onDidChangeTimeframe(() => this.refreshFromGlobal('timeframe')),
			vscode.window.tabGroups.onDidChangeTabs(() => this.resolveMissingTabIds()),
			this.sessionManager.onSessionStopped(event => this.detachLiveSession(event.sessionId)),
			this.reducedMotion.onDidChange(() => this.broadcastReducedMotion()),
			this.sessionManager.onFill(update => this.handleLiveFill(update))
		);
	}

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(ChartViewProvider.viewType, this, {
				supportsMultipleEditorsPerDocument: true,
				webviewOptions: { retainContextWhenHidden: true }
			}),
			vscode.commands.registerCommand('quantlab.chart.refresh', () => this.withActiveSession(session => this.reloadData(session))),
			vscode.commands.registerCommand('quantlab.chart.applyParameters', () => this.withActiveSession(session => this.applyOverrides(session))),
			vscode.commands.registerCommand('quantlab.chart.resetParameters', () => this.withActiveSession(session => this.resetOverrides(session))),
			vscode.commands.registerCommand('quantlab.chart.toggleParameters', () => this.withActiveSession(session => this.toggleParameters(session))),
			vscode.commands.registerCommand('quantlab.chart.screenshot', () => this.withActiveSession(session => this.requestScreenshot(session))),
			vscode.commands.registerCommand('quantlab.chart.openSettings', () => this.withActiveSession(session => this.openSettings(session))),
			vscode.commands.registerCommand('quantlab.chart.addVisualizationTemplate', () => this.withActiveSession(session => this.addVisualizationTemplate(session))),
			vscode.commands.registerCommand('quantlab.chart.generateVisualization', () => this.withActiveSession(session => this.generateVisualization(session)))
		);
	}

	static getInstance(): ChartViewProvider {
		if (!ChartViewProvider.instance) {
			throw new Error('ChartViewProvider not initialized');
		}
		return ChartViewProvider.instance;
	}

	showRunArtifacts(runId: string, uri?: vscode.Uri): void {
		const session = uri ? this.findSessionForDocument(uri) : this.getActiveSession();
		if (!session) {
			if (uri) {
				this.pendingRunByUri.set(uri.toString(), runId);
			}
			return;
		}

		this.executeWithErrorBoundary(() => this.loadRunArtifacts(session, runId), 'loadRunArtifacts');
	}

	attachLiveSession(sessionId: string, uri?: vscode.Uri): void {
		const session = uri ? this.findSessionForDocument(uri) : this.getActiveSession();
		if (!session) {
			if (uri) {
				this.pendingLiveByUri.set(uri.toString(), sessionId);
			}
			return;
		}

		const info = this.sessionManager.getSession(sessionId);
		if (!info) {
			return;
		}

		const key = session.key;
		if (this.liveSessions.get(key)?.sessionId === sessionId) {
			return;
		}

		this.detachLiveSessionByKey(key);

		const previous = session.tabInstanceId ? this.stateManager.getChartState(session.tabInstanceId) : undefined;
		this.liveSessions.set(key, {
			sessionId,
			previous: { symbol: previous?.symbol, timeframe: previous?.timeframe }
		});

		this.tradeOverlayManager.attach(key, sessionId, message => session.webview.postMessage(message));

		if (session.tabInstanceId) {
			this.stateManager.updateChartState(session.tabInstanceId, { symbol: info.symbol, timeframe: info.timeframe });
		}

		this.refreshToolbar(session);
		this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
	}

	detachLiveSession(sessionId: string): void {
		for (const [key, binding] of this.liveSessions.entries()) {
			if (binding.sessionId !== sessionId) {
				continue;
			}
			this.detachLiveSessionByKey(key);
		}
	}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		webviewPanel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		webviewPanel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this.context.extensionUri,
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
			]
		};

		const html = ChartWebview.buildHtml(webviewPanel.webview, this.context.extensionUri);
		const chartWebview = new ChartWebview(webviewPanel);
		chartWebview.initialize(html);

		const session: ChartSession = {
			key: `${document.uri.toString()}::${Date.now()}`,
			tabInstanceId: this.resolveTabInstanceId(document, webviewPanel),
			document,
			panel: webviewPanel,
			webview: chartWebview,
			disposables: [],
			analysisDebounced: debounce(() => this.refreshAnalysis(session), 250),
			visualizationDebounced: debounce(() => this.refreshVisualization(session), 250)
		};

		this.sessions.set(session.key, session);

		session.disposables.push(
			chartWebview.onMessage(message => this.onMessage(session, message)),
			webviewPanel.onDidDispose(() => this.disposeSession(session)),
			webviewPanel.onDidChangeViewState(() => {
				if (webviewPanel.active) {
					this.refreshToolbar(session);
				}
			}),
			vscode.workspace.onDidChangeTextDocument(event => {
				if (event.document.uri.toString() === document.uri.toString()) {
					session.analysisDebounced();
				}
			})
		);

		this.themeProvider.registerWebview(session.key, chartWebview);
		this.sendReducedMotion(session);

		if (!session.tabInstanceId) {
			this.resolveMissingTabIds();
		}
	}

	private disposeSession(session: ChartSession): void {
		// Detach live session BEFORE removing from sessions map
		this.detachLiveSessionByKey(session.key);

		// Cancel any pending data load operations
		if (session.cancellationTokenSource) {
			session.cancellationTokenSource.cancel();
			session.cancellationTokenSource.dispose();
		}

		this.themeProvider.unregisterWebview(session.key);
		this.sessions.delete(session.key);
		this.dataCache.delete(session.key);
		this.dataCacheAccessTimes.delete(session.key);
		this.bannerState.delete(session.key);
		this.lastNotifiedVizIssues.delete(session.key);
		this.liveSessions.delete(session.key);

		const uriKey = session.document.uri.toString();
		this.artifactCache.delete(session.key);
		this.artifactCacheAccessTimes.delete(session.key);
		this.pendingRunByUri.delete(uriKey);
		this.pendingLiveByUri.delete(uriKey);

		for (const disposable of session.disposables) {
			disposable.dispose();
		}

		if (session.tabInstanceId) {
			this.chartStateStore.clearTab(session.tabInstanceId);
		}
	}

	private async onMessage(session: ChartSession, message: unknown): Promise<void> {
		if (!message || typeof message !== 'object') {
			return;
		}

		const payload = message as ChartInboundMessage;
		switch (payload.type) {
			case 'ready':
				session.webview.markReady();
				await this.initializeSession(session);
				return;
			case 'parameterChange': {
				this.chartStateStore.setOverride(this.getSessionKey(session), payload.id, payload.value);
				const overrides = this.chartStateStore.getOverrides(this.getSessionKey(session));
				session.webview.postMessage({ type: 'setOverrides', overrides });
				if (session.tabInstanceId) {
					this.stateManager.updateChartState(session.tabInstanceId, { parameterOverrides: overrides });
				}
				FeatureDiscovery.getInstance().notifyParameterEdit();
				session.visualizationDebounced();
				return;
			}
			case 'resetDefaults':
				this.resetOverrides(session);
				session.visualizationDebounced();
				return;
			case 'applyToCode':
				await this.applyOverrides(session);
				session.visualizationDebounced();
				return;
			case 'requestFilePicker':
				await this.handleFilePicker(session);
				return;
			case 'selectDataSource':
				this.handleSelectDataSource(session, payload.filePath);
				return;
			case 'selectServerSymbol':
				this.handleSelectServerSymbol(session, payload.symbol, payload.displayName);
				return;
			case 'overrideDateRange':
				this.updateChartOverride(session, { dateRange: payload.range });
				return;
			case 'refresh':
				this.reloadData(session);
				return;
			case 'screenshot':
				this.requestScreenshot(session);
				return;
			case 'openSettings':
				this.openSettings(session);
				return;
			case 'toggleFullscreen':
				vscode.commands.executeCommand('workbench.action.toggleZenMode');
				return;
			case 'selectTool':
				// Drawing tools not yet wired -- reserved for future use
				return;
			case 'toggleParameters':
				this.setPanelCollapsed(session, payload.collapsed);
				return;
			case 'addVisualization':
				await this.addVisualizationTemplate(session);
				return;
			case 'generateVisualization':
				await this.generateVisualization(session);
				return;
			case 'editVisualization':
				await this.openVisualizationSource(session);
				return;
			case 'dropFile': {
				const dropped = payload.filePath;
				if (dropped && (dropped.endsWith('.csv') || dropped.endsWith('.parquet'))) {
					const source: DataSourceDescriptor = {
						kind: 'localFile',
						filePath: dropped,
						displayName: path.basename(dropped)
					};
					// Set global state only - refreshFromGlobal will propagate to tabs without overrides
					this.globalState.setDataSource(source);
					this.refreshToolbar(session);
					this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
				}
				return;
			}
			case 'dropRun':
				this.executeWithErrorBoundary(() => this.loadRunArtifacts(session, payload.runId), 'loadRunArtifacts');
				return;
			default:
				return;
		}
	}

	private async handleFilePicker(session: ChartSession): Promise<void> {
		const uris = await vscode.window.showOpenDialog({
			canSelectMany: false,
			filters: { 'Data Files': ['csv', 'parquet'] },
			openLabel: 'Select Data File'
		});
		if (!uris || !uris.length) {
			return;
		}

		const filePath = uris[0].fsPath;
		const displayName = path.basename(filePath);
		const source: DataSourceDescriptor = { kind: 'localFile', filePath, displayName };

		// Set global state only - refreshFromGlobal will propagate to tabs without overrides
		this.globalState.setDataSource(source);

		this.refreshToolbar(session);
		this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
	}

	private handleSelectDataSource(session: ChartSession, filePath: string): void {
		const displayName = path.basename(filePath);
		const source: DataSourceDescriptor = { kind: 'localFile', filePath, displayName };

		// Set global state only - refreshFromGlobal will propagate to tabs without overrides
		this.globalState.setDataSource(source);

		this.refreshToolbar(session);
		this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
	}

	private handleSelectServerSymbol(session: ChartSession, symbol: string, displayName: string): void {
		const source: ServerDataSource = { kind: 'server', symbol, displayName };

		// Set global state only - refreshFromGlobal will propagate to tabs without overrides
		this.globalState.setDataSource(source);

		this.refreshToolbar(session);
		this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
	}

	private async initializeSession(session: ChartSession): Promise<void> {
		this.sendInit(session);
		this.sendReducedMotion(session);
		this.sendRecentSources(session);
		await this.reloadData(session);

		const cachedArtifacts = this.artifactCache.get(session.key);
		if (cachedArtifacts) {
			if (cachedArtifacts.signals) {
				session.webview.postMessage({ type: 'setSignals', requestId: 0, signals: cachedArtifacts.signals });
			}
			if (cachedArtifacts.equity) {
				session.webview.postMessage({ type: 'setEquityCurve', requestId: 0, equity: cachedArtifacts.equity });
			}
		}

		const pending = this.pendingRunByUri.get(session.document.uri.toString());
		if (pending) {
			this.pendingRunByUri.delete(session.document.uri.toString());
			this.executeWithErrorBoundary(() => this.loadRunArtifacts(session, pending), 'loadRunArtifacts');
		}

		const pendingLive = this.pendingLiveByUri.get(session.document.uri.toString());
		if (pendingLive) {
			this.pendingLiveByUri.delete(session.document.uri.toString());
			this.attachLiveSession(pendingLive, session.document.uri);
		}
	}

	private sendInit(session: ChartSession): void {
		const toolbar = this.buildToolbarState(session);
		const params = this.parameterExtractor.extract(session.document);
		const overrides = this.chartStateStore.getOverrides(this.getSessionKey(session));

		session.webview.postMessage({
			type: 'init',
			payload: {
				theme: this.resolveTheme(),
				toolbar,
				parameters: params.parameters,
				overrides
			}
		});

		const collapsed = this.chartStateStore.isPanelCollapsed(this.getSessionKey(session));
		if (collapsed) {
			session.webview.postMessage({ type: 'toggleParameters', collapsed });
		}
	}

	private sendRecentSources(session: ChartSession): void {
		const sources = this.globalState.getRecentDataSources();
		session.webview.postMessage({ type: 'setRecentSources', sources });
	}

	private sendReducedMotion(session: ChartSession): void {
		session.webview.postMessage({ type: 'reducedMotion', mode: this.reducedMotion.getMode() });
	}

	private broadcastReducedMotion(): void {
		for (const session of this.sessions.values()) {
			this.sendReducedMotion(session);
		}
	}

	private refreshToolbar(session: ChartSession): void {
		const toolbar = this.buildToolbarState(session);
		session.webview.postMessage({ type: 'setToolbar', toolbar });
	}

	private refreshAnalysis(session: ChartSession): void {
		const params = this.parameterExtractor.extract(session.document);
		const complexity = this.complexityAnalyzer.analyze(session.document, params);
		const viz = this.visualizationDetector.detect(session.document);

		session.webview.postMessage({ type: 'setParameters', parameters: params.parameters });
		session.webview.postMessage({ type: 'setComplexity', complexity });
		this.refreshToolbar(session);

		if (complexity.level === 'viewOnly') {
			this.setBanner(session, 'viewOnly', 'View-only mode: visualization is disabled. Run a backtest to view artifacts.', 'warning');
			session.visualizationDebounced();
			return;
		}

		if (!viz.hasVisualization) {
			this.setBanner(session, 'viewOnly', '');
			session.visualizationDebounced();
			return;
		}

		this.setBanner(session, 'viewOnly', '');
		session.visualizationDebounced();
	}

	private async refreshVisualization(session: ChartSession, data?: OhlcvBar[]): Promise<void> {
		const key = this.getSessionKey(session);

		// Generate request ID to prevent race conditions
		const requestId = this.chartStateStore.nextVizRequestId(key);

		const bars = data ?? this.dataCache.get(session.key);
		if (!bars || !bars.length) {
			return;
		}

		const params = this.parameterExtractor.extract(session.document);
		const complexity = this.complexityAnalyzer.analyze(session.document, params);
		const viz = this.visualizationDetector.detect(session.document);

		if (complexity.level === 'viewOnly') {
			// Check if request is still current before sending
			if (!this.chartStateStore.isVizRequestCurrent(key, requestId)) {
				return;
			}
			session.webview.postMessage({
				type: 'setVisualization',
				requestId,
				commands: [{ type: 'clear', target: 'indicators' }]
			});
			session.webview.postMessage({ type: 'showError', message: '' });
			return;
		}

		const overrides = this.chartStateStore.getOverrides(key);
		const artifacts = this.artifactCache.get(session.key);
		const tabId = session.tabInstanceId;
		const chartState = tabId ? this.stateManager.getChartState(tabId) : undefined;
		const timeframe = chartState?.timeframe ?? this.globalState.getTimeframe();
		const vizHash = this.buildVisualizationHash(session.document, bars, overrides, artifacts, timeframe);
		if (this.chartStateStore.getLastVizHash(key) === vizHash) {
			return;
		}

		try {
			const result = await this.visualizationRunner.run(session.document, {
				data: bars,
				overrides,
				signals: artifacts?.signals,
				equity: artifacts?.equity
			});

			// Check if request is still current before sending result
			if (!this.chartStateStore.isVizRequestCurrent(key, requestId)) {
				return;
			}

			// Check if session is still active (prevent accessing disposed session)
			if (!this.isSessionActive(session)) {
				return;
			}

			this.chartStateStore.setLastVizHash(key, vizHash);
			session.webview.postMessage({
				type: 'setVisualization',
				requestId,
				commands: result.commands
			});

			if (result.errors.length && viz.hasVisualization && result.commands.length === 0) {
				// No commands at all -- keep the in-place empty-state overlay AND raise a
				// standard notification (errors surface bottom-right, not as chart chrome).
				session.webview.postMessage({
					type: 'showError',
					message: 'Visualization failed to render.',
					detail: result.errors.join('\n'),
					actions: ['editVisualization']
				});
				this.notifyVisualizationIssues(session, result.errors, 'error');
			} else if (result.errors.length && viz.hasVisualization) {
				// Commands produced but with warnings -- standard notification, no chart banner.
				session.webview.postMessage({ type: 'showError', message: '' });
				this.notifyVisualizationIssues(session, result.errors, 'warning');
			} else {
				session.webview.postMessage({ type: 'showError', message: '' });
				this.lastNotifiedVizIssues.delete(session.key);
			}
		} catch (error) {
			// Check if session is still active before showing error
			if (!this.isSessionActive(session)) {
				return;
			}

			this.setBanner(session, 'data', '');
			const detail = error instanceof Error ? error.message : String(error ?? '');
			session.webview.postMessage({
				type: 'showError',
				message: 'Visualization failed to render.',
				detail,
				actions: ['editVisualization']
			});
			this.notifyVisualizationIssues(session, [detail], 'error');
		}
	}

	/**
	 * Surfaces visualization issues as standard VS Code notifications (bottom-right)
	 * instead of in-chart chrome. Deduplicated per session: visualize() re-runs on every
	 * parameter change, and an unchanged issue list must not toast again.
	 */
	private notifyVisualizationIssues(session: ChartSession, issues: string[], severity: 'warning' | 'error'): void {
		const joined = issues.join(' ');
		if (this.lastNotifiedVizIssues.get(session.key) === joined) {
			return;
		}
		this.lastNotifiedVizIssues.set(session.key, joined);

		const fileName = path.basename(session.document.uri.fsPath);
		const message = `${fileName} visualization: ${joined}`;
		if (severity === 'error') {
			void vscode.window.showErrorMessage(message);
		} else {
			void vscode.window.showWarningMessage(message);
		}
	}

	private async reloadData(session: ChartSession): Promise<void> {
		const toolbar = this.buildToolbarState(session);
		const key = this.getSessionKey(session);

		// Cancel any pending data load operation
		if (session.cancellationTokenSource) {
			session.cancellationTokenSource.cancel();
			session.cancellationTokenSource.dispose();
		}

		// Create new cancellation token for this operation
		session.cancellationTokenSource = new vscode.CancellationTokenSource();
		const token = session.cancellationTokenSource.token;

		// Generate request ID to prevent race conditions
		const requestId = this.chartStateStore.nextDataRequestId(key);

		if (!toolbar.dataSource) {
			session.webview.postMessage({
				type: 'showError',
				message: 'No data source selected.',
				detail: 'Select a data file or server symbol to load market data.',
				actions: ['selectData']
			});
			return;
		}

		try {
			let data: OhlcvBar[];
			let effectiveTimeframe: Timeframe;
			let dsKey: string;

			if (isLocalFileSource(toolbar.dataSource)) {
				// Load from local file
				const result = await this.dataService.getOHLCVFromFile(toolbar.dataSource.filePath, toolbar.dateRange, token);
				data = result.data;
				effectiveTimeframe = result.meta.effectiveTimeframe;
				dsKey = toolbar.dataSource.filePath;

				if (result.meta.warning) {
					this.setBanner(session, 'data', result.meta.warning, 'warning');
				} else {
					this.setBanner(session, 'data', '');
				}
			} else if (isServerSource(toolbar.dataSource)) {
				// Load from Delta Plus server
				const timeframe = toolbar.timeframe ?? '1D';
				const result = await this.dataService.getOHLCVFromServer(
					toolbar.dataSource.symbol,
					timeframe,
					toolbar.dateRange,
					token,
					toolbar.dataSource.assetClass
				);
				data = result.data;
				effectiveTimeframe = result.meta.effectiveTimeframe;
				dsKey = `server:${toolbar.dataSource.symbol}`;
				this.setBanner(session, 'data', '');
			} else {
				throw new Error('Unknown data source type');
			}

			// Update timeframe from inferred/actual value
			if (session.tabInstanceId) {
				this.stateManager.updateChartState(session.tabInstanceId, { timeframe: effectiveTimeframe });
			}

			// Check if this request is still current (prevent race conditions)
			if (!this.chartStateStore.isDataRequestCurrent(key, requestId)) {
				// A newer request has been initiated, abort this one
				return;
			}

			// Check if session is still active (prevent accessing disposed session)
			if (!this.isSessionActive(session)) {
				return;
			}

			if (!data.length) {
				const sourceName = isServerSource(toolbar.dataSource)
					? toolbar.dataSource.symbol
					: 'this file';
				session.webview.postMessage({
					type: 'showError',
					message: `No data available in ${sourceName}.`,
					actions: ['selectData']
				});
				return;
			}

			// Final check before sending data
			if (!this.chartStateStore.isDataRequestCurrent(key, requestId)) {
				return;
			}

			if (!this.isSessionActive(session)) {
				return;
			}

			const { buffer, count } = encodeOhlcvBars(data);

			session.webview.postMessage({
				type: 'setDataBinary',
				requestId,
				buffer,
				count
			});
			this.setDataCache(session.key, data); // Use LRU cache

			this.chartStateStore.setLastDataKey(key, `${dsKey}:${toolbar.dateRange?.start ?? ''}:${toolbar.dateRange?.end ?? ''}`);

			// Refresh toolbar to show inferred timeframe
			this.refreshToolbar(session);

			await this.refreshVisualization(session, data);
		} catch (error) {
			// Check if session is still active before showing error
			if (!this.isSessionActive(session)) {
				return;
			}

			const detail = error instanceof Error ? error.message : String(error ?? '');
			const isServer = isServerSource(toolbar.dataSource);
			session.webview.postMessage({
				type: 'showError',
				message: isServer ? 'Unable to load data from server.' : 'Unable to load data from file.',
				detail,
				actions: ['reload', 'selectData']
			});
		}
	}

	private buildToolbarState(session: ChartSession): ChartToolbarState {
		const tabId = session.tabInstanceId;
		const chartState = tabId ? this.stateManager.getChartState(tabId) : undefined;
		const dataSource = chartState?.dataSource ?? this.globalState.getDataSource();
		const timeframe = chartState?.timeframe ?? this.globalState.getTimeframe();
		const dateRange = chartState?.dateRange;
		const params = this.parameterExtractor.extract(session.document);
		const complexity = this.complexityAnalyzer.analyze(session.document, params);
		const viz = this.visualizationDetector.detect(session.document);
		const recentSources = this.globalState.getRecentDataSources();

		return {
			dataSource,
			timeframe,
			dateRange,
			recentSources,
			complexity,
			hasVisualization: viz.hasVisualization,
			viewOnly: complexity.level === 'viewOnly'
		};
	}

	private buildVisualizationHash(
		document: vscode.TextDocument,
		data: OhlcvBar[],
		overrides: Record<string, unknown>,
		artifacts?: { signals?: SignalMarker[]; equity?: EquityPoint[] },
		timeframe?: string
	): string {
		const first = data[0]?.t ?? 0;
		const last = data[data.length - 1]?.t ?? 0;
		const overrideKey = JSON.stringify(overrides);
		const signals = artifacts?.signals ?? [];
		const equity = artifacts?.equity ?? [];
		const signalsCount = signals.length;
		const equityCount = equity.length;
		const signalsHead = signalsCount ? signals[0]?.t ?? 0 : 0;
		const signalsTail = signalsCount ? signals[signalsCount - 1]?.t ?? 0 : 0;
		const equityHead = equityCount ? equity[0]?.t ?? 0 : 0;
		const equityTail = equityCount ? equity[equityCount - 1]?.t ?? 0 : 0;
		const tf = timeframe ?? '';
		return `${document.version}:${data.length}:${first}:${last}:${signalsCount}:${signalsHead}:${signalsTail}:${equityCount}:${equityHead}:${equityTail}:${tf}:${overrideKey}`;
	}

	private updateChartOverride(session: ChartSession, update: Partial<{ dateRange?: ChartToolbarState['dateRange'] }>): void {
		if (!session.tabInstanceId) {
			return;
		}

		const chartState = this.stateManager.updateChartState(session.tabInstanceId, {
			dateRange: update.dateRange
		});
		if (!chartState) {
			return;
		}

		this.refreshToolbar(session);
		this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
	}

	private refreshFromGlobal(kind: 'dataSource' | 'timeframe'): void {
		for (const session of this.sessions.values()) {
			if (!session.tabInstanceId) {
				continue;
			}

			if (this.liveSessions.has(session.key)) {
				continue;
			}

			const state = this.stateManager.getChartState(session.tabInstanceId);
			if (kind === 'dataSource' && state?.dataSource) {
				continue;
			}
			if (kind === 'timeframe' && state?.timeframe) {
				continue;
			}

			this.refreshToolbar(session);
			this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
		}
	}

	private broadcastTheme(): void {
		const theme = this.resolveTheme();
		for (const session of this.sessions.values()) {
			session.webview.postMessage({ type: 'setTheme', theme });
		}
	}

	private resolveTheme(): 'light' | 'dark' {
		const kind = vscode.window.activeColorTheme.kind;
		return kind === vscode.ColorThemeKind.Light ? 'light' : 'dark';
	}

	private getSessionKey(session: ChartSession): string {
		return session.tabInstanceId ?? session.key;
	}

	private handleLiveFill(update: { sessionId: string; fill: unknown; seq?: number }): void {
		for (const [key, binding] of this.liveSessions.entries()) {
			if (binding.sessionId !== update.sessionId) {
				continue;
			}

			const session = Array.from(this.sessions.values()).find(s => s.key === key);
			if (!session) {
				continue;
			}

			const fill = update.fill as { symbol: string; side: string; quantity: number; price: number; timestamp: number };
			if (fill && fill.timestamp && fill.price) {
				const signal: SignalMarker = {
					t: fill.timestamp,
					type: fill.side === 'buy' ? 'entry' : 'exit',
					label: `${fill.side.toUpperCase()} ${fill.quantity} @ ${fill.price}`,
					price: fill.price
				};

				// Guard: check the live binding is still active (this is the invariant,
				// not this.sessions -- if the live binding was removed by disposeSession,
				// the session no longer participates in fill routing)
				if (!this.liveSessions.has(key)) {
					continue;
				}

				const artifacts = this.artifactCache.get(session.key) ?? {};
				const signals = [...(artifacts.signals ?? []), signal];
				artifacts.signals = signals;
				this.setArtifactCache(session.key, artifacts); // Use LRU cache

				session.webview.postMessage({
					type: 'addSignal',
					signal
				});
			}
		}
	}

	private detachLiveSessionByKey(key: string): void {
		const binding = this.liveSessions.get(key);
		if (!binding) {
			return;
		}

		this.tradeOverlayManager.detach(key);
		this.liveSessions.delete(key);

		const session = Array.from(this.sessions.values()).find(candidate => candidate.key === key);
		if (!session || !session.tabInstanceId) {
			return;
		}

		const previous = binding.previous ?? {};
		this.stateManager.updateChartState(session.tabInstanceId, {
			symbol: previous.symbol,
			timeframe: previous.timeframe
		});
		this.refreshToolbar(session);
		this.executeWithErrorBoundary(() => this.reloadData(session), 'reloadData');
	}

	private async applyOverrides(session: ChartSession): Promise<void> {
		const overrides = this.chartStateStore.getOverrides(this.getSessionKey(session));
		const applied = await applyParameterOverrides(session.document, overrides);
		if (applied) {
			this.resetOverrides(session);
		}
		session.visualizationDebounced();
	}

	private resetOverrides(session: ChartSession): void {
		this.chartStateStore.clearOverrides(this.getSessionKey(session));
		session.webview.postMessage({ type: 'setOverrides', overrides: {} });
		if (session.tabInstanceId) {
			this.stateManager.updateChartState(session.tabInstanceId, { parameterOverrides: {} });
		}
		session.visualizationDebounced();
	}

	private setPanelCollapsed(session: ChartSession, collapsed: boolean): void {
		this.chartStateStore.setPanelCollapsed(this.getSessionKey(session), collapsed);
		if (session.tabInstanceId) {
			this.stateManager.updateChartState(session.tabInstanceId, { panelCollapsed: collapsed });
		}
	}

	private toggleParameters(session: ChartSession): void {
		const collapsed = !this.chartStateStore.isPanelCollapsed(this.getSessionKey(session));
		this.chartStateStore.setPanelCollapsed(this.getSessionKey(session), collapsed);
		session.webview.postMessage({ type: 'toggleParameters', collapsed });
	}

	private requestScreenshot(_session: ChartSession): void {
		vscode.window.showInformationMessage('Screenshot export is not wired yet.');
	}

	private openSettings(_session: ChartSession): void {
		vscode.window.showInformationMessage('Chart settings are not available yet.');
	}

	private async openVisualizationSource(session: ChartSession): Promise<void> {
		const editor = await vscode.window.showTextDocument(session.document, { preview: false });
		const text = session.document.getText();
		const match = /def\s+visualize\b/.exec(text) ?? /visualize\s*\(/.exec(text);
		if (!match) {
			return;
		}
		const position = session.document.positionAt(match.index);
		editor.selection = new vscode.Selection(position, position);
		editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
	}

	private async addVisualizationTemplate(session: ChartSession): Promise<void> {
		const document = session.document;
		const detection = this.visualizationDetector.detect(document);
		if (detection.hasVisualization) {
			void vscode.window.showInformationMessage('Visualization template already exists in this file.');
			return;
		}

		const template = getVisualizationTemplate();
		const text = document.getText();
		let separator = '';
		if (text.length) {
			if (text.endsWith('\n\n')) {
				separator = '';
			} else if (text.endsWith('\n')) {
				separator = '\n';
			} else {
				separator = '\n\n';
			}
		}

		const edit = new vscode.WorkspaceEdit();
		edit.insert(document.uri, document.positionAt(text.length), `${separator}${template}`);
		const applied = await vscode.workspace.applyEdit(edit);
		if (applied) {
			void vscode.window.showInformationMessage('Visualization template added.');
		} else {
			void vscode.window.showWarningMessage('Unable to insert visualization template.');
		}
	}

	private async generateVisualization(_session: ChartSession): Promise<void> {
		vscode.window.showInformationMessage('Visualization generation is not available yet.');
	}

	private async loadRunArtifacts(session: ChartSession, runId: string): Promise<void> {
		const artifacts = await this.getRunArtifacts(runId);

		// Check if session is still active after async operation
		if (!this.isSessionActive(session)) {
			return;
		}

		if (!artifacts || (!artifacts.signals && !artifacts.equity)) {
			this.setBanner(session, 'run', 'No artifacts found for this run.', 'warning');
			return;
		}

		if (artifacts.signals) {
			session.webview.postMessage({ type: 'setSignals', requestId: 0, signals: artifacts.signals });
		}
		if (artifacts.equity) {
			session.webview.postMessage({ type: 'setEquityCurve', requestId: 0, equity: artifacts.equity });
		}
		this.setArtifactCache(session.key, {
			signals: artifacts.signals,
			equity: artifacts.equity
		});
		this.executeWithErrorBoundary(() => this.refreshVisualization(session), 'refreshVisualization');

		const entry = this.historyState.getEntry(runId);
		if (entry) {
			this.setBanner(session, 'run', `Showing results for ${entry.type} run ${entry.id}.`, 'info');
		}
	}

	private setBanner(session: ChartSession, kind: BannerKind, message: string, tone?: 'info' | 'warning'): void {
		const state = this.bannerState.get(session.key) ?? {};
		if (message) {
			state[kind] = { message, tone };
		} else {
			delete state[kind];
		}
		this.bannerState.set(session.key, state);
		this.renderBanner(session);
	}

	private renderBanner(session: ChartSession): void {
		const state = this.bannerState.get(session.key);
		const banner = state?.viewOnly ?? state?.run ?? state?.data;
		if (!banner) {
			session.webview.postMessage({ type: 'showBanner', message: '' });
			return;
		}
		session.webview.postMessage({ type: 'showBanner', message: banner.message, tone: banner.tone });
	}

	private async getRunArtifacts(runId: string) {
		const cached = this.historyState.getRunArtifacts(runId);
		if (cached) {
			return cached;
		}

		const entry = this.historyState.getEntry(runId);
		if (!entry || !entry.artifactPath) {
			return undefined;
		}

		const signals = await this.readArtifactJson<Array<{ t: number; type: 'entry' | 'exit'; label?: string; price?: number }>>(entry.artifactPath, 'signals.json');
		const equity = await this.readArtifactJson<Array<{ t: number; v: number }>>(entry.artifactPath, 'equity.json');

		const artifacts = { signals, equity };
		this.historyState.setRunArtifacts(runId, artifacts);
		return artifacts;
	}

	private async readArtifactJson<T>(artifactPath: string, fileName: string): Promise<T | undefined> {
		try {
			const root = vscode.Uri.file(artifactPath);
			const uri = vscode.Uri.joinPath(root, fileName);
			const data = await vscode.workspace.fs.readFile(uri);
			return JSON.parse(Buffer.from(data).toString('utf8')) as T;
		} catch {
			return undefined;
		}
	}

	private resolveTabInstanceId(document: vscode.TextDocument, panel: vscode.WebviewPanel): string | undefined {
		const groups = vscode.window.tabGroups.all;
		for (const group of groups) {
			const groupIndex = groups.indexOf(group);
			if (panel.viewColumn && group.viewColumn !== panel.viewColumn) {
				continue;
			}
			for (let tabIndex = 0; tabIndex < group.tabs.length; tabIndex++) {
				const tab = group.tabs[tabIndex];
				if (tab.input instanceof vscode.TabInputCustom &&
					tab.input.viewType === ChartViewProvider.viewType &&
					tab.input.uri.toString() === document.uri.toString()) {
					return `${document.uri.toString()}::${groupIndex}::${tabIndex}`;
				}
			}
		}
		return undefined;
	}

	private resolveMissingTabIds(): void {
		for (const session of this.sessions.values()) {
			if (!session.tabInstanceId) {
				const resolved = this.resolveTabInstanceId(session.document, session.panel);
				if (resolved) {
					session.tabInstanceId = resolved;
				}
			}
		}
	}

	private withActiveSession(handler: (session: ChartSession) => void): void {
		const active = this.getActiveSession();
		if (!active) {
			void vscode.window.showInformationMessage('No active chart view.');
			return;
		}
		handler(active);
	}

	private getActiveSession(): ChartSession | undefined {
		return Array.from(this.sessions.values()).find(session => session.panel.active);
	}

	private findSessionForDocument(uri: vscode.Uri): ChartSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.document.uri.toString() === uri.toString()) {
				return session;
			}
		}
		return undefined;
	}

	// ----
	// LRU Cache Management (prevent unbounded growth)
	// ----

	/**
	 * Set data in cache with LRU eviction
	 */
	private setDataCache(key: string, data: OhlcvBar[]): void {
		// Evict least-recently-used if at capacity
		if (this.dataCache.size >= ChartViewProvider.MAX_DATA_CACHE_SIZE && !this.dataCache.has(key)) {
			let lruKey: string | undefined;
			let lruTime = Infinity;

			for (const [k, time] of this.dataCacheAccessTimes) {
				if (time < lruTime) {
					lruTime = time;
					lruKey = k;
				}
			}

			if (lruKey) {
				this.dataCache.delete(lruKey);
				this.dataCacheAccessTimes.delete(lruKey);
			}
		}

		this.dataCache.set(key, data);
		this.dataCacheAccessTimes.set(key, Date.now());
	}

	/**
	 * Set artifact in cache with LRU eviction
	 */
	private setArtifactCache(key: string, artifacts: { signals?: SignalMarker[]; equity?: EquityPoint[] }): void {
		// Evict least-recently-used if at capacity
		if (this.artifactCache.size >= ChartViewProvider.MAX_ARTIFACT_CACHE_SIZE && !this.artifactCache.has(key)) {
			let lruKey: string | undefined;
			let lruTime = Infinity;

			for (const [k, time] of this.artifactCacheAccessTimes) {
				if (time < lruTime) {
					lruTime = time;
					lruKey = k;
				}
			}

			if (lruKey) {
				this.artifactCache.delete(lruKey);
				this.artifactCacheAccessTimes.delete(lruKey);
			}
		}

		this.artifactCache.set(key, artifacts);
		this.artifactCacheAccessTimes.set(key, Date.now());
	}

	/**
	 * Check if a session is still active (not disposed).
	 * Use this in async operations before accessing session.webview to prevent errors.
	 */
	private isSessionActive(session: ChartSession): boolean {
		return this.sessions.has(session.key);
	}

	/**
	 * Execute an async operation with error boundary.
	 * Catches and logs errors from fire-and-forget async calls.
	 */
	private executeWithErrorBoundary(operation: () => Promise<void>, operationName: string): void {
		operation().catch(error => {
			console.error(`ChartViewProvider.${operationName} failed:`, error);
			// Optionally show error to user for critical operations
			if (operationName.includes('reload') || operationName.includes('load')) {
				void vscode.window.showErrorMessage(
					`Failed to ${operationName}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		});
	}
}
