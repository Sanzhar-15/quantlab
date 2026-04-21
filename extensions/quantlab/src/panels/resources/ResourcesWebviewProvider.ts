/*---------------------------------------------------------------------------------------------
 *  Resources Panel WebviewViewProvider
 *  Renders ~566 quantitative analysis tools from server catalog with search,
 *  tier toggles, implementation status, and collapse persistence.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getWebviewUri, getNonce } from '../../utils/webview';
import { ResourcesCatalogService } from './ResourcesCatalogService';
import { ClientSection } from '../../types/resources';

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

	private constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly catalogService: ResourcesCatalogService,
	) {}

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

	// ── Message handling ──────────────────────────────────────────────────────

	private async handleMessage(message: ResourcesMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
			case 'requestCatalog':
				await this.sendCatalog();
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

	private async sendCatalog(): Promise<void> {
		try {
			const catalog = await this.catalogService.getCatalog();

			if (!catalog) {
				this.postMessage({
					type: 'catalogUnavailable',
					message: 'Could not load catalog. Connect to the Delta Plus Server and retry.',
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
			}
		} catch {
			this.postMessage({
				type: 'catalogUnavailable',
				message: 'Failed to load catalog.',
			});
		}
	}

	// ── Tool click routing ────────────────────────────────────────────────────

	private async handleToolClick(serverToolId: string): Promise<void> {
		const tool = this.catalogService.getToolById(serverToolId);
		if (!tool || !tool.implemented) {
			// Unimplemented tools handled entirely in webview (cursor + tooltip)
			return;
		}

		// Offline resources always route to Action view
		if (this.catalogService.isOfflineResource(serverToolId)) {
			void vscode.commands.executeCommand('quantlab.action.openResource', serverToolId);
			return;
		}

		// Server tools: route by section
		const section = this.catalogService.getSectionForTool(serverToolId);

		if (section === 'stats') {
			// Pass server canonical ID — StatsViewProvider handles mapping
			void vscode.commands.executeCommand('quantlab.openStatsTest', serverToolId);
		} else if (section === 'strategy') {
			void vscode.commands.executeCommand('quantlab.action.openResource', serverToolId);
		}
	}

	// ── Workflow click ────────────────────────────────────────────────────────

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
				`Workflow "${workflow.label}" — all ${workflow.steps.length} steps are planned for future release.`,
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

	// ── Cross-reference navigation ────────────────────────────────────────────

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

	// ── Public API ────────────────────────────────────────────────────────────

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

	// ── HTML ──────────────────────────────────────────────────────────────────

	private getHtmlForWebview(webview: vscode.Webview): string {
		const scriptUri = getWebviewUri(webview, this.extensionUri, [
			'dist', 'webview', 'resources.js',
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
