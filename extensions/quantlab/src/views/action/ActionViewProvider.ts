/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EngineHost } from '../../core/engine/EngineHost';
import { GlobalState } from '../../core/state/GlobalState';
import { HistoryState } from '../../core/state/HistoryState';
import { TabViewStateManager } from '../../core/state/TabViewState';
import { StrategyValidator } from '../../core/strategy/StrategyValidator';
import { ParameterExtractor } from '../../core/strategy/ParameterExtractor';
import * as path from 'path';
import { HistoryEntry } from '../../types/history';
import { ActionConfig, ActionConfigurationState, ActionLogEntry, ActionPromptState, ActionResultsState, ActionRunningState, ActionSelectionState, ActionState, QuickActionType, StrategyInfo } from '../../types/action';
import { DataSourceDescriptor, isServerSource, Timeframe } from '../../types/market';
import { EngineEvent, JobRequest, JobResult } from '../../types/engine';
import { ServerDataCache } from '../../core/engine/ServerDataCache';
import { isOfflineResource } from '../../types/resources';
import { ViewManager } from '../ViewManager';
import { ActionStateMachine } from './ActionStateMachine';
import { ActionWebview } from './ActionWebview';
import { QuickActions } from './QuickActions';
import { ResultsExporter } from './ResultsExporter';
import { ChartViewProvider } from '../chart/ChartViewProvider';
import { ThemeProvider } from '../../ui/tokens/ThemeProvider';
import { ReducedMotion } from '../../ui/accessibility/ReducedMotion';
import { ParameterDefinition } from '../../types/strategy';
import { ColumnInfo } from '../../types/data';
import { getOfflineResourceSchema, getOfflineResourceMeta } from '../../panels/resources/OfflineResourcesCatalog';
import { StatsEngine } from '../../stats/StatsEngine';
import { StatsTestConfig } from '../../types/stats';

const MAX_LOG_RUNS = 50;

interface ActionSession {
	key: string;
	tabInstanceId?: string;
	fileType: 'strategy' | 'data';
	document: vscode.TextDocument;
	panel: vscode.WebviewPanel;
	webview: ActionWebview;
	disposables: vscode.Disposable[];
}

/**
 * The sessions map is keyed by session.key (`uri::timestamp`), while engine
 * events route by tabInstanceId (`uri::groupIndex::tabIndex`) -- the two key
 * shapes NEVER match, so a Map.get(tabId) lookup silently drops every event
 * (megaudit H23/H32). Sessions must be resolved by iterating on
 * tabInstanceId, the same way postState does.
 */
export function findSessionByTabInstanceId<T extends { tabInstanceId?: string }>(
	sessions: Iterable<T>,
	tabId: string
): T | undefined {
	for (const session of sessions) {
		if (session.tabInstanceId === tabId) {
			return session;
		}
	}
	return undefined;
}

export class ActionViewProvider implements vscode.CustomTextEditorProvider {
	static readonly viewType = 'quantlab.actionView';

	private readonly sessions = new Map<string, ActionSession>();
	private readonly stateMachine = new ActionStateMachine();
	private readonly runLogs = new Map<string, ActionLogEntry[]>();
	private readonly engineHost = EngineHost.getInstance();
	private readonly validator = StrategyValidator.getInstance();
	private readonly parameterExtractor = ParameterExtractor.getInstance();
	private readonly resultsExporter: ResultsExporter;
	private readonly viewManager = ViewManager.getInstance();
	private readonly themeProvider = ThemeProvider.getInstance();
	private readonly reducedMotion = ReducedMotion.getInstance();

	private readonly jobToTab = new Map<string, string>();
	private readonly pendingRunByUri = new Map<string, string>();
	private readonly pendingResourceByUri = new Map<string, string>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly globalState: GlobalState,
		private readonly historyState: HistoryState,
		private readonly tabStateManager: TabViewStateManager
	) {
		this.resultsExporter = new ResultsExporter(historyState);

		context.subscriptions.push(
			this.stateMachine.onDidChangeState(({ tabId, state }) => this.postState(tabId, state)),
			this.engineHost.onDidEmit(event => this.onEngineEvent(event)),
			this.historyState.onDidChange(() => this.refreshSelections()),
			this.reducedMotion.onDidChange(() => this.broadcastReducedMotion())
		);
	}

	register(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.window.registerCustomEditorProvider(ActionViewProvider.viewType, this, {
				supportsMultipleEditorsPerDocument: true
			}),
			vscode.commands.registerCommand('quantlab.action.open', () => this.openForActiveEditor()),
			vscode.commands.registerCommand('quantlab.action.openRun', (runId?: string) => this.openRun(runId)),
			vscode.commands.registerCommand('quantlab.action.openResource', (resourceId?: string) => this.openResource(resourceId)),
			vscode.commands.registerCommand('quantlab.action.viewInChart', (runId?: string) => this.viewInChart(runId)),
			vscode.commands.registerCommand('quantlab.action.exportResults', (runId?: string, format?: string) => {
				if (!runId || (format !== 'json' && format !== 'csv' && format !== 'html')) {
					return;
				}
				this.executeWithErrorBoundary(() => this.resultsExporter.export(runId, format), 'export');
			}),
			vscode.commands.registerCommand('quantlab.action.pinRun', (runId?: string) => {
				if (runId) {
					this.historyState.togglePin(runId);
				}
			}),
			vscode.commands.registerCommand('quantlab.action.addToCompare', (runId?: string) => {
				if (runId) {
					this.historyState.addToCompare(runId);
				}
			})
		);
	}

	async resolveCustomTextEditor(
		document: vscode.TextDocument,
		panel: vscode.WebviewPanel,
		_token: vscode.CancellationToken
	): Promise<void> {
		panel.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				this.context.extensionUri,
				vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview')
			]
		};

		const html = ActionWebview.buildHtml(panel.webview, this.context.extensionUri);
		const webview = new ActionWebview(panel);
		webview.initialize(html);

		const ext = path.extname(document.uri.fsPath).toLowerCase();
		const fileType = ['.csv', '.parquet', '.xlsx'].includes(ext) ? 'data' as const : 'strategy' as const;

		const session: ActionSession = {
			key: `${document.uri.toString()}::${Date.now()}`,
			tabInstanceId: this.resolveTabInstanceId(document, panel),
			fileType,
			document,
			panel,
			webview,
			disposables: []
		};

		this.sessions.set(session.key, session);

		session.disposables.push(
			webview.onMessage(message => this.onMessage(session, message)),
			panel.onDidDispose(() => this.disposeSession(session))
		);

		this.themeProvider.registerWebview(session.key, webview);
		this.sendReducedMotion(session);

		if (!session.tabInstanceId) {
			this.resolveMissingTabIds();
		}
	}

	private disposeSession(session: ActionSession): void {
		this.themeProvider.unregisterWebview(session.key);
		this.sessions.delete(session.key);
		for (const disposable of session.disposables) {
			disposable.dispose();
		}
	}

	private onMessage(session: ActionSession, message: unknown): void {
		if (!message || typeof message !== 'object') {
			return;
		}

		const payload = message as { type?: string };
		if (!payload.type) {
			return;
		}

		switch (payload.type) {
			case 'ready':
				session.webview.markReady();
				this.initializeSession(session);
				return;
			case 'quickAction': {
				const action = (payload as { action?: unknown }).action;
				if (typeof action === 'string') {
					this.runQuickAction(session, action as QuickActionType);
				}
				return;
			}
			case 'runAction': {
				const msg = payload as { actionType?: unknown; config?: unknown };
				if (typeof msg.actionType === 'string' && msg.config && typeof msg.config === 'object') {
					this.executeWithErrorBoundary(() => this.runAction(session, msg as { actionType: string; config: ActionConfig }), 'runAction');
				}
				return;
			}
			case 'updateConfig': {
				const values = (payload as { values?: unknown }).values;
				if (values && typeof values === 'object') {
					this.updateConfig(session, payload as { values: Record<string, unknown> });
				}
				return;
			}
			case 'requestFilePicker':
				this.executeWithErrorBoundary(() => this.handleFilePicker(session, (payload as { fieldId?: string }).fieldId), 'handleFilePicker');
				return;
			case 'back':
				this.transitionToPrompt(session);
				return;
			case 'cancelJob': {
				const jobId = (payload as { jobId?: unknown }).jobId;
				if (typeof jobId === 'string') {
					this.cancelJob(jobId);
				}
				return;
			}
			case 'selectRun': {
				const runId = (payload as { runId?: unknown }).runId;
				if (typeof runId === 'string') {
					this.executeWithErrorBoundary(() => this.showRun(session, runId), 'showRun');
				}
				return;
			}
			case 'viewInChart': {
				const runId = (payload as { runId?: unknown }).runId;
				if (typeof runId === 'string') {
					this.executeWithErrorBoundary(() => this.viewInChart(runId), 'viewInChart');
				}
				return;
			}
			case 'exportResults': {
				const msg = payload as { runId?: unknown; format?: unknown };
				if (typeof msg.runId === 'string' && typeof msg.format === 'string') {
					this.exportResults(msg as { runId: string; format: 'json' | 'csv' | 'html' });
				}
				return;
			}
			case 'pinRun': {
				const runId = (payload as { runId?: unknown }).runId;
				if (typeof runId === 'string') {
					this.historyState.togglePin(runId);
				}
				return;
			}
			case 'addToCompare': {
				const runId = (payload as { runId?: unknown }).runId;
				if (typeof runId === 'string') {
					this.historyState.addToCompare(runId);
				}
				return;
			}
			case 'selectResource': {
				const resourceId = (payload as { resourceId?: unknown }).resourceId;
				if (typeof resourceId === 'string') {
					this.executeWithErrorBoundary(() => this.openResource(resourceId, session), 'openResource');
				}
				return;
			}
			case 'requestColumns': {
				const filePath = (payload as { filePath?: unknown }).filePath;
				if (typeof filePath === 'string') {
					this.executeWithErrorBoundary(() => this.handleColumnDiscovery(session, filePath), 'handleColumnDiscovery');
				}
				return;
			}
			case 'rerun': {
				const runId = (payload as { runId?: unknown }).runId;
				if (typeof runId === 'string') {
					this.executeWithErrorBoundary(() => this.rerunFromHistory(session, runId), 'rerunFromHistory');
				}
				return;
			}
			default:
				return;
		}
	}

	private initializeSession(session: ActionSession): void {
		if (session.fileType === 'strategy') {
			const strategy = this.buildStrategyInfo(session.document);
			const recentRuns = this.getRecentRuns(session.document);
			session.webview.postMessage({ type: 'init', strategy, fileType: 'strategy', recentRuns: recentRuns.map(this.serializeHistoryEntry) });
		} else {
			session.webview.postMessage({ type: 'init', fileType: 'data', filePath: session.document.uri.fsPath });
		}
		this.sendReducedMotion(session);

		const tabId = this.getSessionTabId(session);
		const existingState = tabId ? this.stateMachine.getState(tabId) : undefined;
		if (existingState && tabId) {
			this.postState(tabId, existingState);
		} else {
			this.transitionToPrompt(session);
		}

		const pending = this.pendingRunByUri.get(session.document.uri.toString());
		if (pending) {
			this.pendingRunByUri.delete(session.document.uri.toString());
			this.executeWithErrorBoundary(() => this.showRun(session, pending), 'showRun');
		}

		const pendingResource = this.pendingResourceByUri.get(session.document.uri.toString());
		if (pendingResource) {
			this.pendingResourceByUri.delete(session.document.uri.toString());
			this.executeWithErrorBoundary(() => this.openResource(pendingResource, session), 'openResource');
		}
	}

	private sendReducedMotion(session: ActionSession): void {
		session.webview.postMessage({ type: 'reducedMotion', mode: this.reducedMotion.getMode() });
	}

	private broadcastReducedMotion(): void {
		for (const session of this.sessions.values()) {
			this.sendReducedMotion(session);
		}
	}

	private transitionToPrompt(session: ActionSession): void {
		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		const state: ActionPromptState = {
			type: 'prompt',
			fileType: session.fileType,
			filePath: session.document.uri.fsPath
		};
		this.stateMachine.toPrompt(tabId, state);
	}

	private runQuickAction(session: ActionSession, action: QuickActionType): void {
		if (!session.document) {
			return;
		}

		const parameters = this.parameterExtractor.extract(session.document);
		const values = QuickActions.buildDefaults(action, this.globalState, parameters.parameters);
		this.executeWithErrorBoundary(() => this.runAction(session, { actionType: action, config: { action, values } }), 'runAction');
	}

	private async runAction(session: ActionSession, payload: { actionType: string; config: ActionConfig }): Promise<void> {
		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		// Check if this is an offline stats resource (actionType carries the resourceId)
		const actionType = payload.actionType;
		if (actionType === 'offline-stationarity' || actionType === 'offline-normality') {
			await this.runOfflineStatsTest(session, tabId, actionType, payload.config.values);
			return;
		}

		// Flush editor buffer to disk so the Python process reads current code
		if (session.document.isDirty) {
			await session.document.save();
		}

		// Map offline strategy resources to their action type
		let action: QuickActionType;
		if (payload.actionType === 'offline-backtest') {
			action = 'backtest';
		} else if (payload.actionType === 'offline-montecarlo') {
			action = 'monteCarlo';
		} else {
			action = payload.actionType as QuickActionType;
		}
		const parameters = this.parameterExtractor.extract(session.document);
		const configValues = payload.config.values ?? {};

		// Validate data source is set
		if (!configValues.dataSource) {
			void vscode.window.showWarningMessage('No data source selected. Please select a data file before running.');
			return;
		}
		const resolvedValues = this.applyParameterSource(
			configValues,
			parameters.parameters,
			this.normalizeParamSource(configValues.paramSource),
			this.getChartOverrides(tabId)
		);
		const schema = this.buildSchemaForAction(action, session.document);
		const validation = this.stateMachine.validateConfig(resolvedValues, this.getRequiredFields(schema), this.getNumberRanges(schema));

		if (!validation.isValid) {
			const state: ActionConfigurationState = {
				type: 'configuration',
				action,
				schema,
				values: resolvedValues,
				validation
			};
			this.stateMachine.toConfiguration(tabId, state);
			return;
		}

		// Check if using server data source and cache it to temp CSV
		let finalValues = resolvedValues;
		const dataSource = this.globalState.getDataSource();
		if (dataSource && isServerSource(dataSource)) {
			try {
				const timeframe = (resolvedValues.timeframe ?? this.globalState.getTimeframe() ?? '1D') as Timeframe;
				const cachePath = await ServerDataCache.getInstance().fetchAndCacheToCSV(dataSource, timeframe);
				// Replace dataSource value with cached CSV path
				finalValues = {
					...resolvedValues,
					dataSource: cachePath
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				void vscode.window.showErrorMessage(`Failed to fetch server data: ${message}`);
				return;
			}
		}

		const config: ActionConfig = {
			...payload.config,
			values: finalValues
		};
		const runId = this.createRunId(action);
		let artifactPath = '';
		try {
			artifactPath = await this.writeConfigArtifact(runId, config);
		} catch (error) {
			// The run can proceed without the config artifact, but a failed write must be
			// visible -- it means the run's config won't be reproducible from History.
			console.error(`Failed to write config artifact for run ${runId}:`, error);
			void vscode.window.showWarningMessage('Run config could not be saved -- Rerun from History will use current defaults for this run.');
			artifactPath = '';
		}
		const historyEntry = this.historyState.createEntry({
			id: runId,
			type: action,
			status: 'running',
			strategyPath: session.document.uri.fsPath,
			strategyHash: this.hashText(session.document.getText()),
			startedAt: new Date(),
			progress: 0,
			progressMessage: 'Starting',
			artifactPath,
			pinned: false,
			tags: []
		});

		this.jobToTab.set(runId, tabId);
		this.cacheRunLogs(runId, []);
		const runningState: ActionRunningState = {
			type: 'running',
			jobId: runId,
			action,
			startedAt: new Date().toISOString(),
			progress: 0,
			message: 'Starting...',
			logs: []
		};
		this.stateMachine.toRunning(tabId, runningState);

		const request: JobRequest = {
			jobId: runId,
			action,
			strategyPath: session.document.uri.fsPath,
			strategyHash: historyEntry.strategyHash,
			config,
			createdAt: new Date().toISOString()
		};
		await this.engineHost.runJob(request);
	}

	private async runOfflineStatsTest(session: ActionSession, tabId: string, resourceId: string, values: Record<string, unknown>): Promise<void> {
		const dataPath = (values.dataSource as string) || session.document.uri.fsPath;
		const column = values.column as string | undefined;
		const testMethod = values.testMethod as string;

		// Map resource + method to stats testId
		let testId: string;
		if (resourceId === 'offline-stationarity') {
			testId = testMethod; // adf, kpss, pp
		} else {
			// normality sub-tests
			testId = 'normality';
		}

		const parameters: Record<string, unknown> = {};
		if (resourceId === 'offline-stationarity') {
			if (values.regression) { parameters.regression = values.regression; }
			if (values.maxlag !== undefined && values.maxlag !== '') { parameters.maxlag = Number(values.maxlag); }
		} else {
			parameters.test_method = testMethod;
			if (values.alpha !== undefined && values.alpha !== '') { parameters.alpha = Number(values.alpha); }
		}

		const config: StatsTestConfig = {
			testId,
			dataPath,
			columns: column ? [column] : [],
			parameters,
		};

		const runId = this.createRunId(resourceId);
		const meta = getOfflineResourceMeta(resourceId);

		// Transition to running state
		const runningState: ActionRunningState = {
			type: 'running',
			jobId: runId,
			action: resourceId,
			startedAt: new Date().toISOString(),
			progress: 0,
			message: 'Starting test...',
			logs: [],
		};
		this.stateMachine.toRunning(tabId, runningState);

		try {
			const statsEngine = StatsEngine.getInstance();
			const result = await statsEngine.executeTest(config, (progress) => {
				const state = this.stateMachine.getState(tabId);
				if (state && state.type === 'running') {
					this.stateMachine.toRunning(tabId, {
						...state,
						progress: progress.progress,
						message: progress.message,
					});
				}
			});

			// Convert StatsTestResult → ActionResultsState
			const metrics: Record<string, number> = {};
			if (result.statistic !== undefined) { metrics['Test Statistic'] = result.statistic; }
			if (result.pValue !== null && result.pValue !== undefined) { metrics['p-Value'] = result.pValue; }
			if (result.criticalValues) {
				for (const [k, v] of Object.entries(result.criticalValues)) {
					metrics[`Critical Value (${k})`] = v;
				}
			}

			const resultsState: ActionResultsState = {
				type: 'results',
				runId,
				action: resourceId,
				status: 'completed',
				metrics,
				durationMs: Date.now() - new Date(runningState.startedAt).getTime(),
				resourceId,
				resourceMeta: meta ?? undefined,
			};

			// Attach stats result for webview rendering
			resultsState.statsResult = result;

			this.stateMachine.toResults(tabId, resultsState);
		} catch (err) {
			const resultsState: ActionResultsState = {
				type: 'results',
				runId,
				action: resourceId,
				status: 'failed',
				error: err instanceof Error ? err.message : String(err),
				resourceId,
				resourceMeta: meta ?? undefined,
			};
			this.stateMachine.toResults(tabId, resultsState);
		}
	}

	private updateConfig(session: ActionSession, payload: { values: Record<string, unknown> }): void {
		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		const current = this.stateMachine.getState(tabId);
		if (!current || current.type !== 'configuration') {
			return;
		}

		const schema = current.schema;
		const parameters = session.fileType === 'strategy'
			? this.parameterExtractor.extract(session.document)
			: { parameters: [], warnings: [], hasErrors: false };
		const paramFieldIds = this.getParameterFieldIds(parameters.parameters);
		const nextValues = { ...payload.values };
		const prevSource = this.normalizeParamSource(current.values.paramSource);
		let nextSource = this.normalizeParamSource(nextValues.paramSource);

		const sourceChanged = nextSource !== prevSource;
		const paramChanged = paramFieldIds.some(field => nextValues[field] !== current.values[field]);
		if (!sourceChanged && nextSource !== 'custom' && paramChanged) {
			nextSource = 'custom';
			nextValues.paramSource = 'custom';
		}

		const resolvedValues = this.applyParameterSource(
			nextValues,
			parameters.parameters,
			nextSource,
			this.getChartOverrides(tabId)
		);
		const validation = this.stateMachine.validateConfig(resolvedValues, this.getRequiredFields(schema), this.getNumberRanges(schema));
		const next: ActionConfigurationState = {
			...current,
			values: resolvedValues,
			validation
		};
		this.stateMachine.toConfiguration(tabId, next);
	}

	private cancelJob(jobId: string): void {
		if (!jobId) {
			return;
		}
		this.engineHost.cancelJob(jobId);
	}

	private async handleFilePicker(session: ActionSession, fieldId?: string): Promise<void> {
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

		// Update global state
		const source: DataSourceDescriptor = { kind: 'localFile', filePath, displayName };
		this.globalState.setDataSource(source);

		// Send result back to webview
		session.webview.postMessage({
			type: 'setFieldValue',
			fieldId: fieldId ?? 'dataSource',
			value: filePath,
			displayName
		});

		// After setting field value, inspect file for columns and date range
		const tabId = this.getSessionTabId(session);
		const state = tabId ? this.stateMachine.getState(tabId) : undefined;

		// Discover columns for stats resources
		if (state?.type === 'configuration' && (state.resourceId === 'offline-stationarity' || state.resourceId === 'offline-normality')) {
			this.executeWithErrorBoundary(() => this.handleColumnDiscovery(session, filePath), 'handleColumnDiscovery');
		}

		// Auto-populate date range for all actions
		try {
			const fileInfo = await vscode.commands.executeCommand<{
				columns: ColumnInfo[];
				preview: { rows: number; sample: Record<string, unknown>[] };
				dateRange?: { start: string; end: string };
			}>('quantlab.getDataFileColumns', filePath);

			if (fileInfo?.dateRange) {
				// Auto-populate date fields
				session.webview.postMessage({
					type: 'setFieldValue',
					fieldId: 'dateStart',
					value: fileInfo.dateRange.start,
					displayName: '' // Date inputs don't use display name
				});
				session.webview.postMessage({
					type: 'setFieldValue',
					fieldId: 'dateEnd',
					value: fileInfo.dateRange.end,
					displayName: '' // Date inputs don't use display name
				});

				// Send metadata for preset calculation
				session.webview.postMessage({
					type: 'setDataSourceMetadata',
					metadata: {
						dateRange: {
							start: fileInfo.dateRange.start,
							end: fileInfo.dateRange.end
						}
					}
				});
			}
		} catch (error) {
			console.error('Failed to inspect data file:', error);
		}
	}

	private async handleColumnDiscovery(session: ActionSession, filePath: string): Promise<void> {
		try {
			const columns = await vscode.commands.executeCommand<ColumnInfo[]>(
				'quantlab.getDataFileColumns', filePath
			);
			if (columns) {
				const numeric = columns.filter(c => c.dtype === 'float64' || c.dtype === 'int64');
				session.webview.postMessage({
					type: 'setColumnOptions',
					options: numeric.map(c => ({ label: c.name, value: c.name }))
				});
			}
		} catch (error) {
			console.error('Failed to discover columns:', error);
		}
	}

	private async showRun(session: ActionSession, runId: string): Promise<void> {
		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			void vscode.window.showWarningMessage('Run not found.');
			return;
		}

		if (entry.status === 'running' || entry.status === 'queued') {
			const logs = this.getCachedLogs(entry.id) ?? [];
			const runningState: ActionRunningState = {
				type: 'running',
				jobId: entry.id,
				action: entry.type,
				startedAt: entry.startedAt.toISOString(),
				progress: entry.progress ?? 0,
				message: entry.progressMessage,
				logs
			};
			this.stateMachine.toRunning(tabId, runningState);
			return;
		}

		const logs = this.getCachedLogs(entry.id) ?? await this.loadPersistedLogs(entry.artifactPath);
		if (logs && logs.length) {
			this.cacheRunLogs(entry.id, logs);
		}
		const results: ActionResultsState = {
			type: 'results',
			runId: entry.id,
			action: entry.type,
			status: entry.status,
			metrics: entry.metrics,
			warnings: entry.warnings,
			error: entry.errorMessage,
			artifactPath: entry.artifactPath,
			durationMs: entry.completedAt ? entry.completedAt.getTime() - entry.startedAt.getTime() : undefined,
			logs: logs && logs.length ? logs : undefined
		};
		this.stateMachine.toResults(tabId, results);
		this.historyState.markAsViewed(entry.id);
	}

	private async rerunFromHistory(session: ActionSession, runId: string): Promise<void> {
		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			void vscode.window.showWarningMessage('Run not found.');
			return;
		}

		const action = entry.type;
		if (!this.isQuickAction(action)) {
			void vscode.window.showWarningMessage('This run type cannot be re-run from Action view.');
			return;
		}

		const config = await this.loadConfig(entry.artifactPath);
		if (!config) {
			// Re-running with defaults instead of the recorded config silently
			// changes run parameters -- the operator must know (megaudit M60).
			void vscode.window.showWarningMessage('Original run config could not be loaded -- re-running with current defaults.');
		}
		const parameters = this.parameterExtractor.extract(session.document);
		const values = config ?? QuickActions.buildDefaults(action, this.globalState, parameters.parameters);
		await this.runAction(session, { actionType: action, config: { action, values } });
	}

	private async loadConfig(artifactPath: string): Promise<Record<string, unknown> | undefined> {
		if (!artifactPath) {
			return undefined;
		}
		try {
			const uri = vscode.Uri.file(artifactPath);
			const configUri = vscode.Uri.joinPath(uri, 'config.json');
			const data = await vscode.workspace.fs.readFile(configUri);
			return JSON.parse(Buffer.from(data).toString('utf8')) as Record<string, unknown>;
		} catch (error) {
			console.error(`ActionViewProvider: failed to load run config from ${artifactPath}:`, error);
			return undefined;
		}
	}

	private exportResults(payload: { runId: string; format: 'json' | 'csv' | 'html' }): void {
		if (!payload.runId) {
			return;
		}
		this.executeWithErrorBoundary(() => this.resultsExporter.export(payload.runId, payload.format), 'export');
	}

	private async viewInChart(runId?: string): Promise<void> {
		if (!runId) {
			return;
		}
		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			void vscode.window.showWarningMessage('Run not found.');
			return;
		}

		const doc = await vscode.workspace.openTextDocument(entry.strategyPath);
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		await this.viewManager.switchView(editor, 'chart');

		try {
			const chartProvider = ChartViewProvider.getInstance();
			chartProvider.showRunArtifacts(runId, doc.uri);
		} catch {
			void vscode.window.showWarningMessage('Chart view is not available.');
		}
	}

	private async openRun(runId?: string): Promise<void> {
		if (!runId) {
			return;
		}

		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			void vscode.window.showWarningMessage('Run not found.');
			return;
		}

		const doc = await vscode.workspace.openTextDocument(entry.strategyPath);
		const editor = await vscode.window.showTextDocument(doc, { preview: false });
		await this.viewManager.switchView(editor, 'action');

		const session = this.findSessionForDocument(doc.uri);
		if (session) {
			this.executeWithErrorBoundary(() => this.showRun(session, runId), 'showRun');
		} else {
			this.pendingRunByUri.set(doc.uri.toString(), runId);
		}
	}

	private async openResource(resourceId?: string, session?: ActionSession): Promise<void> {
		if (!resourceId) {
			return;
		}

		if (!session) {
			this.openForActiveEditor(resourceId);
			return;
		}

		const tabId = this.getSessionTabId(session);
		if (!tabId) {
			return;
		}

		// Offline resources use their own schemas
		if (isOfflineResource(resourceId)) {
			const schema = getOfflineResourceSchema(resourceId);
			const meta = getOfflineResourceMeta(resourceId);
			if (!schema) {
				return;
			}

			const isStatsResource = resourceId === 'offline-stationarity' || resourceId === 'offline-normality';
			let values: Record<string, unknown> = { resourceId };

			if (isStatsResource) {
				// For stats resources on data files: pre-fill data source
				if (session.fileType === 'data') {
					values.dataSource = session.document.uri.fsPath;
				}
				// Set default test method
				if (resourceId === 'offline-stationarity') {
					values.testMethod = 'adf';
					values.regression = 'c';
				} else {
					values.testMethod = 'jarque-bera';
					values.alpha = 0.05;
				}

				// Discover columns from data file
				const dataPath = (values.dataSource as string | undefined) || session.document.uri.fsPath;
				if (dataPath && session.fileType === 'data') {
					try {
						const columns = await vscode.commands.executeCommand<ColumnInfo[]>(
							'quantlab.getDataFileColumns', dataPath
						);
						if (columns && columns.length > 0) {
							const columnField = schema.sections[0]?.fields.find(f => f.id === 'column');
							if (columnField) {
								const numeric = columns.filter(c => c.dtype === 'float64' || c.dtype === 'int64');
								columnField.options = numeric.map(c => ({ label: c.name, value: c.name }));
							}
						}
					} catch { /* Column discovery failed -- user can still type column name */ }
				}
			} else {
				// Strategy resources: extract parameters and build defaults
				const action = this.mapResourceToAction(resourceId);
				const parameters = this.parameterExtractor.extract(session.document);
				values = QuickActions.buildDefaults(action, this.globalState, parameters.parameters);
				values.resourceId = resourceId;

				// Add parameter fields to schema
				if (parameters.parameters.length > 0) {
					schema.sections.push({
						id: 'parameters',
						label: 'Strategy Parameters',
						fields: [
							{
								id: 'paramSource', label: 'Parameter Source', type: 'select',
								options: [
									{ label: 'Code Defaults', value: 'code' },
									{ label: 'Chart Overrides', value: 'chart' },
									{ label: 'Custom', value: 'custom' },
								],
							},
							...parameters.parameters.map(param => ({
								id: `param.${param.id}`,
								label: param.name ?? param.id,
								type: typeof param.default === 'number' ? 'number' as const : 'text' as const,
								min: param.min,
								max: param.max,
								step: param.step,
							})),
						],
					});
				}

				const resolvedValues = this.applyParameterSource(
					values,
					parameters.parameters,
					this.normalizeParamSource(values.paramSource),
					this.getChartOverrides(tabId)
				);
				values = resolvedValues;
			}

			const validation = this.stateMachine.validateConfig(values, this.getRequiredFields(schema), this.getNumberRanges(schema));
			this.stateMachine.toConfiguration(tabId, {
				type: 'configuration',
				action: resourceId,
				schema,
				values,
				validation,
				resourceId,
				resourceMeta: meta ?? undefined,
			});
			return;
		}

		// Server resources: existing behavior
		const action = this.mapResourceToAction(resourceId);
		const parameters = this.parameterExtractor.extract(session.document);
		const schema = QuickActions.buildSchema(action, parameters.parameters);
		const values = QuickActions.buildDefaults(action, this.globalState, parameters.parameters);
		values.resourceId = resourceId;

		const resolvedValues = this.applyParameterSource(
			values,
			parameters.parameters,
			this.normalizeParamSource(values.paramSource),
			this.getChartOverrides(tabId)
		);
		const validation = this.stateMachine.validateConfig(resolvedValues, this.getRequiredFields(schema), this.getNumberRanges(schema));

		this.stateMachine.toConfiguration(tabId, {
			type: 'configuration',
			action,
			schema,
			values: resolvedValues,
			validation
		});
	}

	private openForActiveEditor(resourceId?: string): void {
		// First check if there's an active session for any currently open file
		for (const session of this.sessions.values()) {
			if (session.panel.active && resourceId) {
				this.executeWithErrorBoundary(() => this.openResource(resourceId, session), 'openResource');
				return;
			}
		}

		// Try active text editor
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			this.executeWithErrorBoundary(() => this.viewManager.switchView(editor, 'action'), 'switchView');
			const session = this.findSessionForDocument(editor.document.uri);
			if (session && resourceId) {
				this.executeWithErrorBoundary(() => this.openResource(resourceId, session), 'openResource');
				return;
			}
			if (!session && resourceId) {
				this.pendingResourceByUri.set(editor.document.uri.toString(), resourceId);
			}
			return;
		}

		// Try active tab (may be a custom editor like Action view on a data file)
		const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
		if (activeTab?.input instanceof vscode.TabInputCustom) {
			const uri = activeTab.input.uri;
			const session = this.findSessionForDocument(uri);
			if (session && resourceId) {
				this.executeWithErrorBoundary(() => this.openResource(resourceId, session), 'openResource');
				return;
			}
			if (!session && resourceId) {
				this.pendingResourceByUri.set(uri.toString(), resourceId);
			}
		}
	}

	private onEngineEvent(event: EngineEvent): void {
		const tabId = this.jobToTab.get(event.jobId);
		if (!tabId) {
			return;
		}

		// Resolve the session by tabInstanceId (see findSessionByTabInstanceId).
		// A missing session means the tab was closed; terminal events still
		// proceed so HistoryState reaches a final status (finishRun/failRun
		// clean up jobToTab themselves).
		const session = findSessionByTabInstanceId(this.sessions.values(), tabId);

		if (event.type === 'complete' || event.type === 'failed') {
			if (!session) {
				console.warn(`ActionViewProvider: Action tab for job ${event.jobId} is closed; recording terminal state in History only.`);
			}
			if (event.type === 'complete') {
				void this.finishRun(event.jobId, tabId, event.result);
			} else {
				void this.failRun(event.jobId, tabId, event.error);
			}
			return;
		}

		const state = this.stateMachine.getState(tabId);
		if (!state || state.type !== 'running') {
			return;
		}

		if (event.type === 'progress') {
			const next: ActionRunningState = {
				...state,
				progress: Math.min(100, Math.max(0, event.progress)),
				message: event.message
			};
			this.historyState.updateEntry(event.jobId, {
				progress: next.progress,
				progressMessage: next.message,
				status: 'running'
			});
			this.stateMachine.toRunning(tabId, next);
		}

		if (event.type === 'log') {
			const logs = [...state.logs, { timestamp: event.timestamp, message: event.message, level: event.level }];
			const trimmed = logs.slice(-200);
			const next: ActionRunningState = {
				...state,
				logs: trimmed
			};
			this.cacheRunLogs(event.jobId, trimmed);
			this.stateMachine.toRunning(tabId, next);
		}
	}

	private async finishRun(jobId: string, tabId: string, result: JobResult): Promise<void> {
		const entry = this.historyState.getEntry(jobId);
		const completedAt = new Date();
		const artifactPath = await this.writeArtifacts(jobId, result);
		const logs = this.getCachedLogs(jobId);
		if (logs && logs.length) {
			await this.persistRunLogs(jobId, logs);
		}

		this.historyState.updateEntry(jobId, {
			status: 'completed',
			completedAt,
			metrics: result.metrics,
			warnings: result.warnings,
			artifactPath
		});

		if (result.signals || result.equity) {
			this.historyState.setRunArtifacts(jobId, {
				signals: result.signals,
				equity: result.equity
			});
		}

		const resultsState: ActionResultsState = {
			type: 'results',
			runId: jobId,
			action: entry?.type ?? 'backtest',
			status: 'completed',
			metrics: result.metrics,
			warnings: result.warnings,
			artifactPath,
			durationMs: entry?.startedAt ? completedAt.getTime() - entry.startedAt.getTime() : undefined,
			logs: logs && logs.length ? logs : undefined
		};
		this.stateMachine.toResults(tabId, resultsState);
		this.engineHost.completeJob(jobId);
		this.jobToTab.delete(jobId);
	}

	private async failRun(jobId: string, tabId: string, error: string): Promise<void> {
		this.historyState.updateEntry(jobId, {
			status: error.includes('cancelled') ? 'cancelled' : 'failed',
			errorMessage: error,
			completedAt: new Date()
		});

		const entry = this.historyState.getEntry(jobId);
		const logs = this.getCachedLogs(jobId);
		if (logs && logs.length) {
			await this.persistRunLogs(jobId, logs);
		}
		const resultsState: ActionResultsState = {
			type: 'results',
			runId: jobId,
			action: entry?.type ?? 'backtest',
			status: error.includes('cancelled') ? 'cancelled' : 'failed',
			error,
			logs: logs && logs.length ? logs : undefined
		};
		this.stateMachine.toResults(tabId, resultsState);
		this.engineHost.completeJob(jobId);
		this.jobToTab.delete(jobId);
	}

	private getRunFolder(jobId: string): vscode.Uri {
		return vscode.Uri.joinPath(this.context.globalStorageUri, 'quantlab', 'runs', jobId);
	}

	private cacheRunLogs(jobId: string, logs: ActionLogEntry[]): void {
		this.runLogs.set(jobId, logs);
		if (this.runLogs.size > MAX_LOG_RUNS) {
			const oldest = this.runLogs.keys().next().value as string | undefined;
			if (oldest) {
				this.runLogs.delete(oldest);
			}
		}
	}

	private getCachedLogs(jobId: string): ActionLogEntry[] | undefined {
		const logs = this.runLogs.get(jobId);
		return logs ? [...logs] : undefined;
	}

	private async persistRunLogs(jobId: string, logs: ActionLogEntry[]): Promise<void> {
		if (!logs.length) {
			return;
		}
		const runFolder = this.getRunFolder(jobId);
		await vscode.workspace.fs.createDirectory(runFolder);
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(runFolder, 'logs.json'),
			Buffer.from(JSON.stringify(logs, null, 2), 'utf8')
		);
	}

	private async loadPersistedLogs(artifactPath?: string): Promise<ActionLogEntry[] | undefined> {
		if (!artifactPath) {
			return undefined;
		}
		try {
			const logUri = vscode.Uri.joinPath(vscode.Uri.file(artifactPath), 'logs.json');
			const raw = await vscode.workspace.fs.readFile(logUri);
			const parsed = JSON.parse(Buffer.from(raw).toString('utf8'));
			if (!Array.isArray(parsed)) {
				return undefined;
			}
			return parsed
				.map(entry => ({
					timestamp: typeof entry.timestamp === 'string' ? entry.timestamp : '',
					message: typeof entry.message === 'string' ? entry.message : '',
					level: entry.level === 'warn' || entry.level === 'error' || entry.level === 'info' ? entry.level : undefined
				}))
				.filter(entry => entry.timestamp && entry.message);
		} catch {
			return undefined;
		}
	}

	private async writeConfigArtifact(jobId: string, config: ActionConfig): Promise<string> {
		const runFolder = this.getRunFolder(jobId);
		await vscode.workspace.fs.createDirectory(runFolder);
		const payload = config.values ?? {};
		await vscode.workspace.fs.writeFile(
			vscode.Uri.joinPath(runFolder, 'config.json'),
			Buffer.from(JSON.stringify(payload, null, 2), 'utf8')
		);
		return runFolder.fsPath;
	}

	private async writeArtifacts(jobId: string, result: JobResult): Promise<string> {
		const runFolder = this.getRunFolder(jobId);
		await vscode.workspace.fs.createDirectory(runFolder);

		const resultPayload = {
			metrics: result.metrics,
			warnings: result.warnings ?? []
		};
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runFolder, 'result.json'), Buffer.from(JSON.stringify(resultPayload, null, 2), 'utf8'));

		if (result.signals) {
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runFolder, 'signals.json'), Buffer.from(JSON.stringify(result.signals, null, 2), 'utf8'));
		}
		if (result.equity) {
			await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(runFolder, 'equity.json'), Buffer.from(JSON.stringify(result.equity, null, 2), 'utf8'));
		}

		return runFolder.fsPath;
	}

	private postState(tabId: string, state: ActionState): void {
		for (const session of this.sessions.values()) {
			if (session.tabInstanceId === tabId) {
				session.webview.postMessage({ type: 'setState', state: this.serializeState(state) });
			}
		}
	}

	private serializeState(state: ActionState): ActionState {
		if (state.type === 'selection') {
			return { ...state, recentRuns: state.recentRuns.map(this.serializeHistoryEntry) };
		}
		if (state.type === 'results' && state.statsResult) {
			return { ...state };
		}
		return state;
	}

	private serializeHistoryEntry(entry: HistoryEntry): HistoryEntry {
		return {
			...entry,
			startedAt: new Date(entry.startedAt),
			completedAt: entry.completedAt ? new Date(entry.completedAt) : undefined
		};
	}

	private getRecentRuns(document: vscode.TextDocument): HistoryEntry[] {
		return this.historyState.query({ strategyPath: document.uri.fsPath, limit: 5 });
	}

	private refreshSelections(): void {
		for (const session of this.sessions.values()) {
			const tabId = session.tabInstanceId;
			if (!tabId) {
				continue;
			}
			const state = this.stateMachine.getState(tabId);
			if (state && state.type === 'selection') {
				const updated: ActionSelectionState = {
					...state,
					recentRuns: this.getRecentRuns(session.document)
				};
				this.stateMachine.toSelection(tabId, updated);
			}
		}
	}

	private buildStrategyInfo(document: vscode.TextDocument): StrategyInfo {
		const validation = this.validator.validateDocument(document);
		return {
			path: document.uri.fsPath,
			isValid: validation.isValid,
			validationMessage: validation.isValid ? undefined : validation.errors.map(error => error.message).join(', ')
		};
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
					tab.input.viewType === ActionViewProvider.viewType &&
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

	private getSessionTabId(session: ActionSession): string | undefined {
		return session.tabInstanceId ?? this.tabStateManager.getTabInstanceIdForResource(session.document.uri);
	}

	private findSessionForDocument(uri: vscode.Uri): ActionSession | undefined {
		for (const session of this.sessions.values()) {
			if (session.document.uri.toString() === uri.toString()) {
				return session;
			}
		}
		return undefined;
	}

	private createRunId(action: string): string {
		const date = new Date();
		const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
		return `${action}-${stamp}-${Math.random().toString(16).slice(2, 6)}`;
	}

	private hashText(text: string): string {
		let hash = 0;
		for (let i = 0; i < text.length; i++) {
			hash = (hash << 5) - hash + text.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash).toString(16);
	}

	private getRequiredFields(schema: { sections: Array<{ fields: Array<{ id: string; required?: boolean }> }> }): string[] {
		const required: string[] = [];
		for (const section of schema.sections) {
			for (const field of section.fields) {
				if (field.required) {
					required.push(field.id);
				}
			}
		}
		return required;
	}

	private getNumberRanges(schema: { sections: Array<{ fields: Array<{ id: string; min?: number; max?: number }> }> }): Record<string, { min?: number; max?: number }> {
		const ranges: Record<string, { min?: number; max?: number }> = {};
		for (const section of schema.sections) {
			for (const field of section.fields) {
				if (typeof field.min === 'number' || typeof field.max === 'number') {
					ranges[field.id] = { min: field.min, max: field.max };
				}
			}
		}
		return ranges;
	}

	private normalizeParamSource(value: unknown): 'code' | 'chart' | 'custom' {
		if (value === 'chart') {
			return 'chart';
		}
		if (value === 'custom' || value === 'specify') {
			return 'custom';
		}
		return 'code';
	}

	private getChartOverrides(tabId: string): Record<string, unknown> {
		return this.tabStateManager.getChartState(tabId)?.parameterOverrides ?? {};
	}

	private getParameterFieldIds(parameters: ParameterDefinition[]): string[] {
		return parameters.map(param => `param.${param.id}`);
	}

	private applyParameterSource(
		values: Record<string, unknown>,
		parameters: ParameterDefinition[],
		source: 'code' | 'chart' | 'custom',
		overrides: Record<string, unknown>
	): Record<string, unknown> {
		const next: Record<string, unknown> = { ...values, paramSource: source };

		for (const param of parameters) {
			const key = `param.${param.id}`;
			if (source === 'custom') {
				if (!Object.prototype.hasOwnProperty.call(next, key)) {
					next[key] = param.default;
				}
				continue;
			}

			if (source === 'chart' && Object.prototype.hasOwnProperty.call(overrides, param.id)) {
				next[key] = overrides[param.id];
				continue;
			}

			next[key] = param.default;
		}

		return next;
	}

	private buildSchemaForAction(action: QuickActionType, document: vscode.TextDocument) {
		const parameters = this.parameterExtractor.extract(document);
		return QuickActions.buildSchema(action, parameters.parameters);
	}

	private mapResourceToAction(resourceId: string): QuickActionType {
		if (resourceId.includes('optimize')) {
			return 'optimize';
		}
		if (resourceId.includes('monte')) {
			return 'monteCarlo';
		}
		if (resourceId.includes('wfa')) {
			return 'wfa';
		}
		return 'backtest';
	}

	private isQuickAction(action: string): action is QuickActionType {
		return action === 'backtest' || action === 'optimize' || action === 'monteCarlo' || action === 'wfa';
	}

	/**
	 * Execute an async operation with error boundary.
	 * Catches and logs errors from fire-and-forget async calls.
	 */
	private executeWithErrorBoundary(operation: () => Promise<void>, operationName: string): void {
		operation().catch(error => {
			console.error(`ActionViewProvider.${operationName} failed:`, error);
			// Optionally show error to user for critical operations
			if (operationName.includes('run') || operationName.includes('export')) {
				void vscode.window.showErrorMessage(
					`Failed to ${operationName}: ${error instanceof Error ? error.message : String(error)}`
				);
			}
		});
	}
}
