# Prompt 06: Resources Panel Webview Provider

## Objective
Convert the Resources panel from TreeDataProvider to WebviewViewProvider to support horizontal section buttons.

## Context
The current Resources panel uses `ResourcesTreeProvider` (TreeDataProvider). We need a webview to render custom UI with horizontal "Strategy" and "Pure Stats" buttons at the top.

## File to Create

### `extensions/quantlab/src/panels/resources/ResourcesWebviewProvider.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Resources Panel WebviewViewProvider
 *  Provides horizontal section buttons (Strategy | Pure Stats) and section content
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { getWebviewUri, getNonce } from '../../utils/webview';

export type ResourcesSection = 'strategy' | 'stats';

interface ResourcesMessage {
    type: 'ready' | 'sectionChange' | 'testClick' | 'itemClick';
    section?: ResourcesSection;
    testId?: string;
    itemId?: string;
}

export class ResourcesWebviewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'quantlab.resourcesPanel';
    private static instance: ResourcesWebviewProvider;

    private view?: vscode.WebviewView;
    private currentSection: ResourcesSection = 'strategy';
    private pendingSection?: ResourcesSection;
    private disposables: vscode.Disposable[] = [];

    private constructor(private readonly extensionUri: vscode.Uri) {}

    static getInstance(extensionUri?: vscode.Uri): ResourcesWebviewProvider {
        if (!ResourcesWebviewProvider.instance) {
            if (!extensionUri) {
                throw new Error('ResourcesWebviewProvider must be initialized with extensionUri');
            }
            ResourcesWebviewProvider.instance = new ResourcesWebviewProvider(extensionUri);
        }
        return ResourcesWebviewProvider.instance;
    }

    static initialize(extensionUri: vscode.Uri): ResourcesWebviewProvider {
        return ResourcesWebviewProvider.getInstance(extensionUri);
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): void {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
                vscode.Uri.joinPath(this.extensionUri, 'media'),
                vscode.Uri.joinPath(this.extensionUri, 'node_modules', '@vscode', 'codicons', 'dist')
            ]
        };

        webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

        // Handle messages from webview - properly dispose
        this.disposables.push(
            webviewView.webview.onDidReceiveMessage(
                (message: ResourcesMessage) => this.handleMessage(message)
            )
        );

        // Cleanup on dispose
        webviewView.onDidDispose(() => {
            this.disposables.forEach(d => d.dispose());
            this.disposables = [];
            this.view = undefined;
        });

        // If there was a pending section change before view was ready
        if (this.pendingSection) {
            this.setSection(this.pendingSection);
            this.pendingSection = undefined;
        }
    }

    private handleMessage(message: ResourcesMessage): void {
        switch (message.type) {
            case 'ready':
                // Webview is ready, send current section
                this.postMessage({ type: 'setSection', section: this.currentSection });
                break;

            case 'sectionChange':
                if (message.section) {
                    this.currentSection = message.section;
                    // Update context for potential menu/command visibility
                    void vscode.commands.executeCommand(
                        'setContext',
                        'quantlab.resourcesSection',
                        this.currentSection
                    );
                }
                break;

            case 'testClick':
                if (message.testId) {
                    // User clicked a statistical test - open Stats view
                    void vscode.commands.executeCommand('quantlab.openStatsTest', message.testId);
                }
                break;

            case 'itemClick':
                if (message.itemId) {
                    // User clicked a strategy resource item
                    void this.handleStrategyItemClick(message.itemId);
                }
                break;
        }
    }

    /**
     * Handle clicks on Strategy section items (Tests, Templates, Guides)
     * These should integrate with existing QuantLab functionality
     */
    private async handleStrategyItemClick(itemId: string): Promise<void> {
        switch (itemId) {
            case 'tests':
                // Open strategy tests panel/view
                await vscode.commands.executeCommand('quantlab.showStrategyTests');
                break;
            case 'templates':
                // Open templates picker
                await vscode.commands.executeCommand('quantlab.showTemplates');
                break;
            case 'guides':
                // Open guides/documentation
                await vscode.commands.executeCommand('quantlab.showGuides');
                break;
            default:
                // Handle sub-items (e.g., specific test, template, or guide)
                if (itemId.startsWith('test:')) {
                    const testName = itemId.substring(5);
                    await vscode.commands.executeCommand('quantlab.runStrategyTest', testName);
                } else if (itemId.startsWith('template:')) {
                    const templateName = itemId.substring(9);
                    await vscode.commands.executeCommand('quantlab.applyTemplate', templateName);
                } else if (itemId.startsWith('guide:')) {
                    const guideName = itemId.substring(6);
                    await vscode.commands.executeCommand('quantlab.openGuide', guideName);
                }
                break;
        }
    }

    /**
     * Set the active section (called from commands)
     */
    setSection(section: ResourcesSection): void {
        this.currentSection = section;

        if (this.view) {
            this.postMessage({ type: 'setSection', section });
            void vscode.commands.executeCommand(
                'setContext',
                'quantlab.resourcesSection',
                section
            );
        } else {
            // View not ready yet, store for later
            this.pendingSection = section;
        }
    }

    /**
     * Get current section
     */
    getSection(): ResourcesSection {
        return this.currentSection;
    }

    private postMessage(message: unknown): void {
        if (this.view) {
            void this.view.webview.postMessage(message);
        }
    }

    private getHtmlForWebview(webview: vscode.Webview): string {
        const scriptUri = getWebviewUri(webview, this.extensionUri, [
            'dist',
            'webview',
            'resources.js'
        ]);
        const styleUri = getWebviewUri(webview, this.extensionUri, [
            'dist',
            'webview',
            'resources.css'
        ]);
        // FIXED: Correct path for @vscode/codicons
        const codiconsUri = getWebviewUri(webview, this.extensionUri, [
            'node_modules',
            '@vscode',
            'codicons',
            'dist',
            'codicon.css'
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
```

## File to Create

### `extensions/quantlab/src/utils/webview.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Webview utility functions
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Generate a URI for a webview resource
 */
export function getWebviewUri(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    pathList: string[]
): vscode.Uri {
    return webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...pathList));
}

/**
 * Generate a nonce for CSP
 */
export function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
```

## Register Command Handler

### Add to `extensions/quantlab/src/commands/dataCommands.ts`

Add this command registration in `registerDataCommands`:

```typescript
import { ResourcesWebviewProvider } from '../panels/resources/ResourcesWebviewProvider';

// Internal command for Resources panel section switching
context.subscriptions.push(
    vscode.commands.registerCommand('quantlab.resources.setSection', (section: 'strategy' | 'stats') => {
        const provider = ResourcesWebviewProvider.getInstance();
        provider.setSection(section);
    })
);
```

## Test

1. Resources panel should render with webview (not tree)
2. Two buttons should appear at top: "Strategy" | "Pure Stats"
3. Clicking buttons should switch sections
4. Console: `quantlab.resourcesSection` context key should update
5. Strategy items should trigger appropriate commands when clicked

## Dependencies
- Prompt 05 (data commands) must be complete
- Webview utilities created

## Next
Proceed to `07_Resources_Webview_Script.md`
