# Phase 2: Resources Panel Redesign - Detailed Implementation

## Objective

Transform the Resources panel from a simple TreeDataProvider to a Webview-based panel with a horizontal mode switcher between "Strategy" and "Pure Stats" sections.

---

## 1. Architecture Decision

### Why Webview?

The current `ResourcesTreeProvider` is a VS Code native TreeView. However, the horizontal button bar UI requirement cannot be achieved with native TreeView. We need a **Webview-based panel** like ActionViewProvider.

### Comparison

| Aspect | TreeDataProvider | Webview Panel |
|--------|------------------|---------------|
| Custom header UI | Not possible | Full control |
| Horizontal buttons | Not possible | Easy |
| Native tree feeling | Native | Can emulate |
| Performance | Better for large trees | Slightly more overhead |
| Complexity | Lower | Higher |

**Decision**: Use Webview with custom tree rendering to enable the horizontal button bar while maintaining the expandable tree behavior.

---

## 2. New File Structure

```
extensions/quantlab/src/panels/resources/
├── ResourcesPanelProvider.ts    # Main webview provider (NEW - replaces TreeProvider)
├── ResourcesWebview.ts          # Webview communication (NEW)
├── ResourcesTreeRenderer.ts     # Tree rendering logic (NEW)
├── StrategyCatalog.ts           # Strategy resources data (extract from existing)
├── StatsCatalog.ts              # Stats resources data (NEW)
├── resourcesCatalog.json        # (KEEP - existing strategy catalog)
├── statsCatalog.json            # (NEW - stats test catalog)
├── html/
│   └── resources.html           # Panel HTML template (NEW)
├── css/
│   └── resources.css            # Panel styles (NEW)
└── ResourcesTreeProvider.ts     # (DELETE after migration)
```

---

## 3. Panel Provider Implementation

### File: `ResourcesPanelProvider.ts`

```typescript
import * as vscode from 'vscode';
import { ResourcesWebview, ResourcesMessage } from './ResourcesWebview';
import { StrategyCatalog, loadStrategyCatalog } from './StrategyCatalog';
import { StatsCatalog, loadStatsCatalog } from './StatsCatalog';

export type ResourcesSection = 'strategy' | 'stats';

interface ResourcesState {
    section: ResourcesSection;
    expandedNodes: Set<string>;
    selectedNode: string | null;
}

export class ResourcesPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'quantlab.resourcesView';

    private view?: vscode.WebviewView;
    private webview?: ResourcesWebview;
    private state: ResourcesState = {
        section: 'strategy',
        expandedNodes: new Set(),
        selectedNode: null
    };

    private strategyCatalog: StrategyCatalog | null = null;
    private statsCatalog: StatsCatalog | null = null;
    private disposables: vscode.Disposable[] = [];

    constructor(
        private readonly extensionUri: vscode.Uri,
        private readonly globalState: vscode.Memento
    ) {
        // Load persisted section preference
        const savedSection = globalState.get<ResourcesSection>('quantlab.resourcesSection');
        if (savedSection) {
            this.state.section = savedSection;
        }
    }

    async resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ): Promise<void> {
        this.view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };

        // Load catalogs
        this.strategyCatalog = await loadStrategyCatalog(this.extensionUri);
        this.statsCatalog = await loadStatsCatalog(this.extensionUri);

        // Set up webview
        this.webview = new ResourcesWebview(webviewView.webview, this.extensionUri);
        this.webview.initialize(this.buildHtml());

        // Handle messages from webview
        this.disposables.push(
            this.webview.onMessage(msg => this.handleMessage(msg))
        );

        // Handle visibility changes
        this.disposables.push(
            webviewView.onDidChangeVisibility(() => {
                if (webviewView.visible) {
                    this.refresh();
                }
            })
        );

        // Initial render
        this.sendState();
    }

    /**
     * Switch to a specific section (called from commands)
     */
    async setSection(section: ResourcesSection): Promise<void> {
        if (this.state.section !== section) {
            this.state.section = section;
            this.state.expandedNodes.clear();
            this.state.selectedNode = null;
            await this.globalState.update('quantlab.resourcesSection', section);
            this.sendState();
        }
    }

    /**
     * Get current section
     */
    getSection(): ResourcesSection {
        return this.state.section;
    }

    /**
     * Refresh the panel content
     */
    refresh(): void {
        this.sendState();
    }

    /**
     * Focus and optionally set section
     */
    async focus(options?: { section?: ResourcesSection }): Promise<void> {
        if (options?.section) {
            await this.setSection(options.section);
        }
        this.view?.show(true);
    }

    private handleMessage(message: ResourcesMessage): void {
        switch (message.type) {
            case 'ready':
                this.sendState();
                break;

            case 'switchSection':
                void this.setSection(message.section as ResourcesSection);
                break;

            case 'toggleNode':
                this.toggleNode(message.nodeId);
                break;

            case 'selectNode':
                this.selectNode(message.nodeId);
                break;

            case 'nodeAction':
                this.handleNodeAction(message.nodeId, message.action);
                break;
        }
    }

    private toggleNode(nodeId: string): void {
        if (this.state.expandedNodes.has(nodeId)) {
            this.state.expandedNodes.delete(nodeId);
        } else {
            this.state.expandedNodes.add(nodeId);
        }
        this.sendState();
    }

    private selectNode(nodeId: string): void {
        this.state.selectedNode = nodeId;
        this.sendState();
    }

    private handleNodeAction(nodeId: string, action: string): void {
        if (this.state.section === 'strategy') {
            // Handle strategy resource click (existing behavior)
            if (action === 'openResource') {
                void vscode.commands.executeCommand('quantlab.action.openResource', nodeId);
            } else if (action === 'openGuide') {
                const guide = this.strategyCatalog?.guides.find(g => g.id === nodeId);
                if (guide?.url) {
                    void vscode.env.openExternal(vscode.Uri.parse(guide.url));
                }
            }
        } else {
            // Handle stats test click
            void vscode.commands.executeCommand('quantlab.stats.openTest', nodeId);
        }
    }

    private sendState(): void {
        if (!this.webview) return;

        const treeData = this.state.section === 'strategy'
            ? this.buildStrategyTree()
            : this.buildStatsTree();

        this.webview.postMessage({
            type: 'setState',
            state: {
                section: this.state.section,
                expandedNodes: Array.from(this.state.expandedNodes),
                selectedNode: this.state.selectedNode,
                tree: treeData
            }
        });
    }

    private buildStrategyTree(): TreeNode[] {
        if (!this.strategyCatalog) return [];

        return [
            {
                id: 'tests',
                label: 'Tests',
                icon: 'beaker',
                collapsible: true,
                children: this.strategyCatalog.tests.map(t => ({
                    id: t.id,
                    label: t.label,
                    icon: 'play',
                    collapsible: false,
                    action: 'openResource'
                }))
            },
            {
                id: 'templates',
                label: 'Templates',
                icon: 'file-code',
                collapsible: true,
                children: this.strategyCatalog.templates.map(t => ({
                    id: t.id,
                    label: t.label,
                    icon: 'file',
                    collapsible: false,
                    action: 'openResource'
                }))
            },
            {
                id: 'guides',
                label: 'Guides',
                icon: 'book',
                collapsible: true,
                children: this.strategyCatalog.guides.map(g => ({
                    id: g.id,
                    label: g.label,
                    icon: 'link-external',
                    collapsible: false,
                    action: 'openGuide'
                }))
            }
        ];
    }

    private buildStatsTree(): TreeNode[] {
        if (!this.statsCatalog) return [];

        return this.statsCatalog.categories.map(category => ({
            id: category.id,
            label: category.label,
            icon: category.icon,
            collapsible: true,
            children: category.tests.map(test => ({
                id: test.id,
                label: test.label,
                description: test.description,
                icon: 'symbol-method',
                collapsible: false,
                action: 'openTest'
            }))
        }));
    }

    private buildHtml(): string {
        return ResourcesWebview.buildHtml(this.view!.webview, this.extensionUri);
    }

    dispose(): void {
        for (const d of this.disposables) {
            d.dispose();
        }
    }
}

interface TreeNode {
    id: string;
    label: string;
    description?: string;
    icon: string;
    collapsible: boolean;
    children?: TreeNode[];
    action?: string;
}
```

---

## 4. Webview Communication

### File: `ResourcesWebview.ts`

```typescript
import * as vscode from 'vscode';

export interface ResourcesMessage {
    type: string;
    [key: string]: unknown;
}

export class ResourcesWebview {
    private readonly _onMessage = new vscode.EventEmitter<ResourcesMessage>();
    readonly onMessage = this._onMessage.event;

    private isReady = false;
    private pendingMessages: unknown[] = [];

    constructor(
        private readonly webview: vscode.Webview,
        private readonly extensionUri: vscode.Uri
    ) {
        webview.onDidReceiveMessage(msg => this._onMessage.fire(msg));
    }

    initialize(html: string): void {
        this.webview.html = html;
    }

    postMessage(message: unknown): void {
        if (!this.isReady) {
            this.pendingMessages.push(message);
            return;
        }
        void this.webview.postMessage(message);
    }

    markReady(): void {
        this.isReady = true;
        for (const msg of this.pendingMessages) {
            void this.webview.postMessage(msg);
        }
        this.pendingMessages = [];
    }

    static buildHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
        const styleUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'src', 'panels', 'resources', 'css', 'resources.css')
        );
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'resources.js')
        );
        const codiconsUri = webview.asWebviewUri(
            vscode.Uri.joinPath(extensionUri, 'node_modules', '@vscode/codicons', 'dist', 'codicon.css')
        );

        const nonce = getNonce();

        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <link href="${codiconsUri}" rel="stylesheet" />
    <link href="${styleUri}" rel="stylesheet" />
    <title>Resources</title>
</head>
<body>
    <div class="resources-panel">
        <div class="mode-switcher">
            <button class="mode-btn" data-section="strategy">
                <span class="codicon codicon-symbol-method"></span>
                Strategy
            </button>
            <button class="mode-btn" data-section="stats">
                <span class="codicon codicon-graph"></span>
                Pure Stats
            </button>
        </div>
        <div class="panel-content">
            <div class="tree-container" role="tree"></div>
        </div>
    </div>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}
```

---

## 5. Panel Styles

### File: `css/resources.css`

```css
/* Reset and base styles */
* {
    box-sizing: border-box;
    margin: 0;
    padding: 0;
}

body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
}

.resources-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
}

/* Mode Switcher - Horizontal Button Bar */
.mode-switcher {
    display: flex;
    gap: 6px;
    padding: 8px 10px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-sideBar-background);
    flex-shrink: 0;
}

.mode-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    padding: 6px 10px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    background: transparent;
    color: var(--vscode-foreground);
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    transition: background-color 0.1s, border-color 0.1s;
}

.mode-btn:hover {
    background: var(--vscode-list-hoverBackground);
}

.mode-btn:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

.mode-btn.active {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border-color: var(--vscode-button-background);
}

.mode-btn .codicon {
    font-size: 14px;
}

/* Panel Content */
.panel-content {
    flex: 1;
    overflow: auto;
}

.tree-container {
    padding: 4px 0;
}

/* Tree Nodes */
.tree-node {
    display: flex;
    flex-direction: column;
}

.tree-node-row {
    display: flex;
    align-items: center;
    padding: 4px 8px;
    cursor: pointer;
    user-select: none;
}

.tree-node-row:hover {
    background: var(--vscode-list-hoverBackground);
}

.tree-node-row.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
}

.tree-node-row:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
}

/* Indentation */
.tree-node[data-depth="1"] .tree-node-row { padding-left: 20px; }
.tree-node[data-depth="2"] .tree-node-row { padding-left: 36px; }
.tree-node[data-depth="3"] .tree-node-row { padding-left: 52px; }

/* Expand/Collapse Toggle */
.tree-toggle {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 4px;
    flex-shrink: 0;
}

.tree-toggle .codicon {
    font-size: 12px;
    transition: transform 0.1s;
}

.tree-node.expanded > .tree-node-row .tree-toggle .codicon {
    transform: rotate(90deg);
}

.tree-toggle.no-children {
    visibility: hidden;
}

/* Node Icon */
.tree-icon {
    width: 16px;
    height: 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    margin-right: 6px;
    flex-shrink: 0;
    color: var(--vscode-symbolIcon-methodForeground);
}

/* Node Label */
.tree-label {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* Node Description (for stats tests) */
.tree-description {
    font-size: 0.9em;
    color: var(--vscode-descriptionForeground);
    margin-left: 8px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
}

/* Children Container */
.tree-children {
    display: none;
}

.tree-node.expanded > .tree-children {
    display: block;
}

/* Empty State */
.empty-state {
    padding: 20px;
    text-align: center;
    color: var(--vscode-descriptionForeground);
}

/* Loading State */
.loading {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 20px;
}

.loading::after {
    content: '';
    width: 16px;
    height: 16px;
    border: 2px solid var(--vscode-progressBar-background);
    border-top-color: transparent;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
}

@keyframes spin {
    to { transform: rotate(360deg); }
}

/* Scrollbar styling */
.panel-content::-webkit-scrollbar {
    width: 10px;
}

.panel-content::-webkit-scrollbar-track {
    background: transparent;
}

.panel-content::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 5px;
}

.panel-content::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
}
```

---

## 6. Webview Script

### File: `webview/resources.ts` (to be bundled)

```typescript
interface TreeNode {
    id: string;
    label: string;
    description?: string;
    icon: string;
    collapsible: boolean;
    children?: TreeNode[];
    action?: string;
}

interface PanelState {
    section: 'strategy' | 'stats';
    expandedNodes: string[];
    selectedNode: string | null;
    tree: TreeNode[];
}

const vscode = acquireVsCodeApi();

let state: PanelState = {
    section: 'strategy',
    expandedNodes: [],
    selectedNode: null,
    tree: []
};

// DOM Elements
const modeBtns = document.querySelectorAll('.mode-btn');
const treeContainer = document.querySelector('.tree-container')!;

// Initialize
function init(): void {
    // Mode button clicks
    modeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.getAttribute('data-section') as 'strategy' | 'stats';
            vscode.postMessage({ type: 'switchSection', section });
        });
    });

    // Notify ready
    vscode.postMessage({ type: 'ready' });
}

// Handle messages from extension
window.addEventListener('message', event => {
    const message = event.data;

    switch (message.type) {
        case 'setState':
            state = message.state;
            render();
            break;
    }
});

// Render the panel
function render(): void {
    // Update mode buttons
    modeBtns.forEach(btn => {
        const section = btn.getAttribute('data-section');
        btn.classList.toggle('active', section === state.section);
    });

    // Render tree
    treeContainer.innerHTML = '';
    if (state.tree.length === 0) {
        treeContainer.innerHTML = '<div class="empty-state">No items</div>';
        return;
    }

    state.tree.forEach(node => {
        const el = renderNode(node, 0);
        treeContainer.appendChild(el);
    });
}

function renderNode(node: TreeNode, depth: number): HTMLElement {
    const nodeEl = document.createElement('div');
    nodeEl.className = 'tree-node';
    nodeEl.setAttribute('data-id', node.id);
    nodeEl.setAttribute('data-depth', String(depth));

    if (state.expandedNodes.includes(node.id)) {
        nodeEl.classList.add('expanded');
    }

    // Node row
    const rowEl = document.createElement('div');
    rowEl.className = 'tree-node-row';
    rowEl.setAttribute('role', 'treeitem');
    rowEl.setAttribute('tabindex', '0');

    if (state.selectedNode === node.id) {
        rowEl.classList.add('selected');
    }

    // Toggle
    const toggleEl = document.createElement('span');
    toggleEl.className = 'tree-toggle';
    if (node.collapsible && node.children?.length) {
        toggleEl.innerHTML = '<span class="codicon codicon-chevron-right"></span>';
        toggleEl.addEventListener('click', e => {
            e.stopPropagation();
            vscode.postMessage({ type: 'toggleNode', nodeId: node.id });
        });
    } else {
        toggleEl.classList.add('no-children');
    }
    rowEl.appendChild(toggleEl);

    // Icon
    const iconEl = document.createElement('span');
    iconEl.className = 'tree-icon';
    iconEl.innerHTML = `<span class="codicon codicon-${node.icon}"></span>`;
    rowEl.appendChild(iconEl);

    // Label
    const labelEl = document.createElement('span');
    labelEl.className = 'tree-label';
    labelEl.textContent = node.label;
    rowEl.appendChild(labelEl);

    // Description (optional)
    if (node.description) {
        const descEl = document.createElement('span');
        descEl.className = 'tree-description';
        descEl.textContent = node.description;
        rowEl.appendChild(descEl);
    }

    // Click handler
    rowEl.addEventListener('click', () => {
        if (node.collapsible && node.children?.length) {
            vscode.postMessage({ type: 'toggleNode', nodeId: node.id });
        } else if (node.action) {
            vscode.postMessage({ type: 'nodeAction', nodeId: node.id, action: node.action });
        }
        vscode.postMessage({ type: 'selectNode', nodeId: node.id });
    });

    // Keyboard handler
    rowEl.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            rowEl.click();
        }
    });

    nodeEl.appendChild(rowEl);

    // Children
    if (node.children?.length) {
        const childrenEl = document.createElement('div');
        childrenEl.className = 'tree-children';
        node.children.forEach(child => {
            childrenEl.appendChild(renderNode(child, depth + 1));
        });
        nodeEl.appendChild(childrenEl);
    }

    return nodeEl;
}

// Start
init();
```

---

## 7. Stats Catalog

### File: `statsCatalog.json`

```json
{
  "categories": [
    {
      "id": "descriptive",
      "label": "Descriptive",
      "icon": "graph",
      "tests": [
        {
          "id": "summary-stats",
          "label": "Summary Statistics",
          "description": "Mean, std, skew, kurtosis"
        },
        {
          "id": "distribution-viz",
          "label": "Distribution Visualization",
          "description": "Histogram and KDE plots"
        },
        {
          "id": "outlier-detection",
          "label": "Outlier Detection",
          "description": "IQR, Z-score methods"
        }
      ]
    },
    {
      "id": "stationarity",
      "label": "Stationarity",
      "icon": "pulse",
      "tests": [
        {
          "id": "adf",
          "label": "Augmented Dickey-Fuller",
          "description": "Unit root test"
        },
        {
          "id": "kpss",
          "label": "KPSS Test",
          "description": "Stationarity test"
        },
        {
          "id": "pp",
          "label": "Phillips-Perron",
          "description": "Robust unit root test"
        },
        {
          "id": "dfgls",
          "label": "DF-GLS Test",
          "description": "Efficient unit root test"
        },
        {
          "id": "zivot-andrews",
          "label": "Zivot-Andrews",
          "description": "Structural break test"
        }
      ]
    },
    {
      "id": "distribution",
      "label": "Distribution",
      "icon": "bell",
      "tests": [
        {
          "id": "jarque-bera",
          "label": "Jarque-Bera",
          "description": "Normality test"
        },
        {
          "id": "shapiro-wilk",
          "label": "Shapiro-Wilk",
          "description": "Normality test (small samples)"
        },
        {
          "id": "anderson-darling",
          "label": "Anderson-Darling",
          "description": "Tail-sensitive normality test"
        },
        {
          "id": "qq-analysis",
          "label": "QQ Analysis",
          "description": "Visual normality check"
        }
      ]
    },
    {
      "id": "dependence",
      "label": "Dependence",
      "icon": "link",
      "tests": [
        {
          "id": "correlation-matrix",
          "label": "Correlation Matrix",
          "description": "Pearson, Spearman, Kendall"
        },
        {
          "id": "acf",
          "label": "Autocorrelation (ACF)",
          "description": "Serial correlation"
        },
        {
          "id": "pacf",
          "label": "Partial Autocorrelation",
          "description": "Direct correlation at lag"
        },
        {
          "id": "ljung-box",
          "label": "Ljung-Box Test",
          "description": "Autocorrelation significance"
        },
        {
          "id": "granger-causality",
          "label": "Granger Causality",
          "description": "Predictive causality"
        },
        {
          "id": "cointegration",
          "label": "Cointegration Tests",
          "description": "Engle-Granger, Johansen"
        }
      ]
    },
    {
      "id": "volatility",
      "label": "Volatility",
      "icon": "flame",
      "tests": [
        {
          "id": "arch-effects",
          "label": "ARCH Effects Test",
          "description": "Engle's LM test"
        },
        {
          "id": "variance-ratio",
          "label": "Variance Ratio",
          "description": "Random walk test"
        },
        {
          "id": "rolling-volatility",
          "label": "Rolling Volatility",
          "description": "Time-varying volatility"
        }
      ]
    },
    {
      "id": "regression",
      "label": "Regression",
      "icon": "graph-line",
      "tests": [
        {
          "id": "ols-summary",
          "label": "OLS Summary",
          "description": "Full regression output"
        },
        {
          "id": "breusch-pagan",
          "label": "Breusch-Pagan",
          "description": "Heteroskedasticity test"
        },
        {
          "id": "white-test",
          "label": "White Test",
          "description": "General heteroskedasticity"
        },
        {
          "id": "durbin-watson",
          "label": "Durbin-Watson",
          "description": "Residual autocorrelation"
        },
        {
          "id": "vif",
          "label": "VIF",
          "description": "Multicollinearity check"
        }
      ]
    },
    {
      "id": "risk",
      "label": "Risk Metrics",
      "icon": "warning",
      "tests": [
        {
          "id": "var",
          "label": "Value at Risk",
          "description": "Historical, Parametric, MC"
        },
        {
          "id": "cvar",
          "label": "Expected Shortfall",
          "description": "Conditional VaR"
        },
        {
          "id": "max-drawdown",
          "label": "Maximum Drawdown",
          "description": "Peak to trough analysis"
        },
        {
          "id": "performance-ratios",
          "label": "Performance Ratios",
          "description": "Sharpe, Sortino, Calmar"
        }
      ]
    }
  ]
}
```

---

## 8. Registration Updates

### File: `extension.ts`

```typescript
// Replace ResourcesTreeProvider registration with ResourcesPanelProvider

import { ResourcesPanelProvider } from './panels/resources/ResourcesPanelProvider';

export function activate(context: vscode.ExtensionContext): void {
    // ... existing code ...

    // Register Resources Panel (Webview)
    const resourcesProvider = new ResourcesPanelProvider(
        context.extensionUri,
        context.globalState
    );

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            ResourcesPanelProvider.viewType,
            resourcesProvider,
            { webviewOptions: { retainContextWhenHidden: true } }
        )
    );

    // Update focus command to support section parameter
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.focusResourcesPanel', async (options?: { section?: 'strategy' | 'stats' }) => {
            await resourcesProvider.focus(options);
        })
    );

    // Add section switch command
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.setResourcesSection', async (section: 'strategy' | 'stats') => {
            await resourcesProvider.setSection(section);
        })
    );
}
```

### File: `package.json`

```json
{
  "contributes": {
    "views": {
      "quantlab-resources": [
        {
          "type": "webview",
          "id": "quantlab.resourcesView",
          "name": "Resources"
        }
      ]
    }
  }
}
```

---

## 9. Testing Checklist

### Unit Tests
- [ ] Mode switching persists to global state
- [ ] Tree building for strategy catalog
- [ ] Tree building for stats catalog
- [ ] Node expansion state management

### Integration Tests
- [ ] Panel loads with correct section
- [ ] Clicking mode button switches content
- [ ] Clicking test opens stats view
- [ ] State persists across panel hide/show

### Manual Testing
- [ ] Open Resources panel - see horizontal buttons
- [ ] Click "Pure Stats" - content changes to stats tree
- [ ] Click "Strategy" - content changes back
- [ ] Expand/collapse categories
- [ ] Click a test - verify stats view opens
- [ ] Close and reopen panel - verify section preference persists
- [ ] Click Action button on data file - verify Pure Stats is selected

---

## 10. Migration Notes

1. **Gradual Migration**: Keep `ResourcesTreeProvider.ts` temporarily until webview is stable
2. **Feature Flag**: Consider adding a setting to toggle between old/new panel
3. **Accessibility**: Ensure keyboard navigation works (Tab, Arrow keys, Enter)
4. **Theme Support**: Test with light, dark, and high contrast themes
