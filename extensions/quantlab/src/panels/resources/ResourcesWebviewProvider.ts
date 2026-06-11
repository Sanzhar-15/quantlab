/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getWebviewUri, getNonce } from '../../utils/webview';
import { ResourcesCatalogService } from './ResourcesCatalogService';
import { ServerApiClient } from '../../core/server/ServerApiClient';
import { ClientSection, TOOL_ID_MAP } from '../../types/resources';

export type ResourcesSection = ClientSection;

interface ResourcesMessage {
	type:
	| 'ready'
	| 'sectionChange'
	| 'toolClick'
	| 'workflowClick'
	| 'crossRefClick'
	| 'toggleImplementedFilter'
	| 'requestCatalog';
	section?: ResourcesSection;
	toolId?: string;
	workflowId?: string;
	targetToolId?: string;
}

export class ResourcesWebviewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'quantlab.resourcesPanel';
	private static instance: ResourcesWebviewProvider;

	private view?: vscode.WebviewView;
	private currentSection: ResourcesSection = 'strategy';
	private pendingSection?: ResourcesSection;
	private disposables: vscode.Disposable[] = [];
	private lastAuthSignedIn?: boolean;

	private constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly catalogService: ResourcesCatalogService,
	) {
		// Sign-in must replace the offline-only catalog with the live one (and
		// sign-out must drop back) without requiring a panel reopen.
		// Megaudit M119: ServerApiClient fires onAuthStateChange(true) on EVERY
		// proactive token refresh (~15min), not only on sign-in -- only a real
		// signed-in/signed-out TRANSITION may force-redownload the catalog.
		// Megaudit M38: failures of this refresh chain must be logged, not
		// swallowed by a bare `void`.
		ServerApiClient.getInstance().onAuthStateChange((signedIn: boolean) => {
			if (signedIn === this.lastAuthSignedIn) {
				return; // token refresh, not an auth transition
			}
			this.lastAuthSignedIn = signedIn;
			void (async () => {
				try {
					await this.catalogService.getCatalog(true);
					if (this.view) {
						await this.sendCatalog();
					}
				} catch (err) {
					console.error('[ResourcesWebviewProvider] auth-state catalog refresh failed:', err);
				}
			})();
		});
	}

	static getInstance(): ResourcesWebviewProvider {
		if (!ResourcesWebviewProvider.instance) {
			throw new Error('ResourcesWebviewProvider not initialized');
		}
		return ResourcesWebviewProvider.instance;
	}

	static initialize(
		extensionUri: vscode.Uri,
		catalogService: ResourcesCatalogService,
	): ResourcesWebviewProvider {
		if (!ResourcesWebviewProvider.instance) {
			ResourcesWebviewProvider.instance = new ResourcesWebviewProvider(extensionUri, catalogService);
		}
		return ResourcesWebviewProvider.instance;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
				vscode.Uri.joinPath(this.extensionUri, 'media'),
				vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist'),
			],
		};

		webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

		this.disposables.push(
			webviewView.webview.onDidReceiveMessage(
				(message: ResourcesMessage) => void this.handleMessage(message),
			),
		);

		webviewView.onDidDispose(() => {
			this.disposables.forEach(d => d.dispose());
			this.disposables = [];
			this.view = undefined;
		});

		if (this.pendingSection) {
			this.setSection(this.pendingSection);
			this.pendingSection = undefined;
		}
	}

	// ---- Message handling ----

	private async handleMessage(message: ResourcesMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.sendCatalog();
				break;

			case 'requestCatalog':
				// Megaudit H20: 'requestCatalog' only arrives from the Retry buttons
				// (stale-cache banner / unavailable state). Retry must force a fresh
				// server fetch -- without forceRefresh the 5-minute memory TTL hands
				// the identical stale catalog straight back.
				await this.sendCatalog(true);
				break;

			case 'sectionChange':
				if (message.section) {
					this.currentSection = message.section;
					void vscode.commands.executeCommand(
						'setContext',
						'quantlab.resourcesSection',
						this.currentSection,
					);
				}
				break;

			case 'toolClick':
				if (message.toolId) {
					await this.handleToolClick(message.toolId);
				}
				break;

			case 'workflowClick':
				if (message.workflowId) {
					await this.handleWorkflowClick(message.workflowId);
				}
				break;

			case 'crossRefClick':
				if (message.targetToolId) {
					this.handleCrossRefClick(message.targetToolId);
				}
				break;

			case 'toggleImplementedFilter':
				// State managed entirely in webview; no provider action needed
				break;
		}
	}

	private async sendCatalog(forceRefresh?: boolean): Promise<void> {
		try {
			const catalog = await this.catalogService.getCatalog(forceRefresh);

			if (!catalog) {
				this.postMessage({
					type: 'catalogUnavailable',
					message: 'Could not load catalog. Connect to Quantlab and retry.',
				});
				return;
			}

			this.postMessage({
				type: 'setCatalog',
				catalog: {
					statistics: catalog.statistics,
					strategy: catalog.strategy,
					workflows: catalog.workflows,
					version: catalog.version,
				},
				section: this.currentSection,
			});

			// Signal stale cache state
			if (catalog.fetchedAt > 0 && Date.now() - catalog.fetchedAt > 24 * 60 * 60 * 1000) {
				this.postMessage({
					type: 'catalogError',
					errorType: 'stale-cache',
					message: 'Using cached catalog. Server unavailable.',
					lastUpdated: catalog.fetchedAt,
				});
			} else if (catalog.version === 'offline') {
				// Megaudit M37: the offline-only catalog has a fresh fetchedAt, so the
				// stale-cache banner never fires for it -- without this the user sees
				// 4 built-in tools with no explanation that the server catalog is gone.
				this.postMessage({
					type: 'catalogError',
					errorType: 'offline',
					message: 'Offline mode -- built-in tools only. Sign in to load the full catalog.',
				});
			}
		} catch (err) {
			// Megaudit H22 (No-Fallbacks): the failure must be logged AND surfaced.
			console.error('[ResourcesWebviewProvider] sendCatalog failed:', err);
			this.postMessage({
				type: 'catalogUnavailable',
				message: 'Failed to load catalog.',
			});
		}
	}

	// ---- Tool click routing ----

	private async handleToolClick(serverToolId: string): Promise<void> {
		const tool = this.catalogService.getToolById(serverToolId);
		if (!tool || !tool.implemented) {
			// Unimplemented tools handled entirely in webview (cursor + tooltip)
			return;
		}

		// Offline resources always route to Action view
		if (this.catalogService.isOfflineResource(serverToolId)) {
			if (!this.warnIfNoActionTarget(tool.label)) {
				return;
			}
			void vscode.commands.executeCommand('quantlab.action.openResource', serverToolId);
			return;
		}

		// Server tools: route by section
		const section = this.catalogService.getSectionForTool(serverToolId);

		if (section === 'stats') {
			// Pass server canonical ID -- StatsViewProvider handles mapping
			void vscode.commands.executeCommand('quantlab.openStatsTest', serverToolId);
		} else if (section === 'strategy') {
			// Megaudit H19: tools whose execution surface is the Stats engine open
			// the Stats view, even when the server catalog files them under the
			// strategy section. TOOL_ID_MAP binds 'sharpe-ratio' to the StatsCatalog
			// 'sharpe' test (Risk-Adjusted Returns); routing it through
			// quantlab.action.openResource instead would fall into
			// mapResourceToAction's 'backtest' default and open a Backtest
			// configuration panel -- the wrong surface for a metric computation.
			if (Object.prototype.hasOwnProperty.call(TOOL_ID_MAP, serverToolId)) {
				void vscode.commands.executeCommand('quantlab.openStatsTest', serverToolId);
				return;
			}
			if (!this.warnIfNoActionTarget(tool.label)) {
				return;
			}
			void vscode.commands.executeCommand('quantlab.action.openResource', serverToolId);
		}
	}

	/**
	 * Megaudit H21: quantlab.action.openResource resolves its target from the
	 * active editor/tab (ActionViewProvider.openForActiveEditor) and returns
	 * SILENTLY when neither exists. Tell the user what the tool needs instead
	 * of doing nothing. Returns true when an action target exists.
	 */
	private warnIfNoActionTarget(toolLabel: string): boolean {
		const hasEditor = !!vscode.window.activeTextEditor;
		const activeTab = vscode.window.tabGroups?.activeTabGroup?.activeTab;
		const hasCustomTab = !!activeTab && activeTab.input instanceof vscode.TabInputCustom;
		if (hasEditor || hasCustomTab) {
			return true;
		}
		void vscode.window.showWarningMessage(
			`"${toolLabel}" needs an open file. Open a strategy (.py) or data file in the editor, then click the tool again.`,
		);
		return false;
	}

	// ---- Workflow click ----

	private async handleWorkflowClick(workflowId: string): Promise<void> {
		const catalog = await this.catalogService.getCatalog();
		if (!catalog) { return; }

		const workflow = catalog.workflows.find(w => w.id === workflowId);
		if (!workflow) { return; }

		const implementedSteps = workflow.steps.filter(stepId => {
			const tool = this.catalogService.getToolById(stepId);
			return tool?.implemented;
		});

		if (implementedSteps.length === 0) {
			void vscode.window.showInformationMessage(
				`Workflow "${workflow.label}" -- all ${workflow.steps.length} steps are planned for future release.`,
			);
			return;
		}

		const choice = await vscode.window.showInformationMessage(
			`Run "${workflow.label}"? (${implementedSteps.length}/${workflow.steps.length} steps available)`,
			'Run Available Steps',
			'Cancel',
		);

		if (choice === 'Run Available Steps') {
			for (const stepId of implementedSteps) {
				await this.handleToolClick(stepId);
			}
		}
	}

	// ---- Cross-reference navigation ----

	private handleCrossRefClick(targetToolId: string): void {
		const targetCat = this.catalogService.getCategoryForTool(targetToolId);
		if (!targetCat) { return; }

		const targetSection = this.catalogService.getSectionForCategory(targetCat.id);
		if (!targetSection) { return; }

		this.currentSection = targetSection;
		this.postMessage({
			type: 'navigateTo',
			section: this.currentSection,
			categoryId: targetCat.id,
			toolId: targetToolId,
		});
	}

	// ---- Public API ----

	setSection(section: ResourcesSection): void {
		this.currentSection = section;

		if (this.view) {
			this.postMessage({ type: 'setSection', section });
			void vscode.commands.executeCommand(
				'setContext',
				'quantlab.resourcesSection',
				section,
			);
		} else {
			this.pendingSection = section;
		}
	}

	getSection(): ResourcesSection {
		return this.currentSection;
	}

	private postMessage(message: unknown): void {
		if (this.view) {
			void this.view.webview.postMessage(message);
		}
	}

	// ---- HTML ----

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = getWebviewUri(webview, this.extensionUri, [
			'dist', 'webview', 'resources.js',
		]);
		// Megaudit M97: load the design-system token bus (--ql-*) like the
		// sibling panels do; resources.css consumes it instead of redefining.
		const tokensUri = getWebviewUri(webview, this.extensionUri, [
			'media', 'tokens.css',
		]);
		const styleUri = getWebviewUri(webview, this.extensionUri, [
			'dist', 'webview', 'resources-style.css',
		]);
		const codiconsUri = getWebviewUri(webview, this.extensionUri, [
			'node_modules', '@vscode', 'codicons', 'dist', 'codicon.css',
		]);

		const nonce = getNonce();

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
	<link href="${codiconsUri}" rel="stylesheet">
	<link href="${tokensUri}" rel="stylesheet">
	<link href="${styleUri}" rel="stylesheet">
	<title>Resources</title>
</head>
<body>
	<div id="resources-root"></div>
	<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}
