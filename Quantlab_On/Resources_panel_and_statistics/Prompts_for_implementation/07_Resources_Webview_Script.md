# Prompt 07: Resources Panel Webview Frontend

## Objective
Create the webview frontend for the Resources panel with horizontal section buttons.

## Context
The ResourcesWebviewProvider (Prompt 06) hosts a webview. This prompt creates the frontend script that renders the UI.

## Files to Create

### `extensions/quantlab/webview/resources/index.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Resources Panel Webview Script
 *--------------------------------------------------------------------------------------------*/

import { STATS_CATALOG, StatsCategory, StatsTestMeta } from './statsCatalog';

type Section = 'strategy' | 'stats';

interface VSCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let currentSection: Section = 'strategy';

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

function init(): void {
    const root = document.getElementById('resources-root');
    if (!root) return;

    root.innerHTML = `
        <div class="resources-container">
            <div class="section-switcher">
                <button class="section-btn" data-section="strategy">Strategy</button>
                <button class="section-btn" data-section="stats">Pure Stats</button>
            </div>
            <div class="section-content" id="section-content"></div>
        </div>
    `;

    // Bind button clicks
    document.querySelectorAll('.section-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const section = btn.getAttribute('data-section') as Section;
            switchSection(section);
        });
    });

    // Listen for messages from extension
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'setSection') {
            switchSection(message.section, false);
        }
    });

    // Notify extension we're ready
    vscode.postMessage({ type: 'ready' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Section Switching
// ─────────────────────────────────────────────────────────────────────────────

function switchSection(section: Section, notify = true): void {
    currentSection = section;

    // Update button states
    document.querySelectorAll('.section-btn').forEach(btn => {
        btn.classList.toggle('active', btn.getAttribute('data-section') === section);
    });

    // Render section content
    const content = document.getElementById('section-content');
    if (content) {
        if (section === 'strategy') {
            renderStrategySection(content);
        } else {
            renderStatsSection(content);
        }
    }

    // Notify extension of section change
    if (notify) {
        vscode.postMessage({ type: 'sectionChange', section });
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Strategy Section
// ─────────────────────────────────────────────────────────────────────────────

function renderStrategySection(container: HTMLElement): void {
    container.innerHTML = `
        <div class="resource-tree">
            <div class="tree-item" data-item="tests">
                <span class="codicon codicon-beaker"></span>
                <span class="item-label">Tests</span>
            </div>
            <div class="tree-item" data-item="templates">
                <span class="codicon codicon-file-code"></span>
                <span class="item-label">Templates</span>
            </div>
            <div class="tree-item" data-item="guides">
                <span class="codicon codicon-book"></span>
                <span class="item-label">Guides</span>
            </div>
        </div>
    `;

    // Bind item clicks
    container.querySelectorAll('.tree-item').forEach(item => {
        item.addEventListener('click', () => {
            const itemId = item.getAttribute('data-item');
            if (itemId) {
                vscode.postMessage({ type: 'itemClick', itemId });
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Stats Section
// ─────────────────────────────────────────────────────────────────────────────

const CATEGORY_LABELS: Record<StatsCategory, string> = {
    descriptive: 'Descriptive Statistics',
    stationarity: 'Stationarity Tests',
    distribution: 'Distribution Tests',
    dependence: 'Dependence Tests',
    volatility: 'Volatility Analysis',
    regression: 'Regression Analysis',
    risk: 'Risk Metrics'
};

const CATEGORY_ICONS: Record<StatsCategory, string> = {
    descriptive: 'graph',
    stationarity: 'pulse',
    distribution: 'graph-scatter',
    dependence: 'link',
    volatility: 'flame',
    regression: 'graph-line',
    risk: 'warning'
};

function renderStatsSection(container: HTMLElement): void {
    const categories = Object.keys(STATS_CATALOG) as StatsCategory[];

    let html = '<div class="stats-categories">';

    for (const category of categories) {
        const tests = STATS_CATALOG[category];
        const label = CATEGORY_LABELS[category];
        const icon = CATEGORY_ICONS[category];

        html += `
            <div class="stats-category" data-category="${category}">
                <div class="category-header">
                    <span class="codicon codicon-chevron-right expand-icon"></span>
                    <span class="codicon codicon-${icon}"></span>
                    <span class="category-label">${label}</span>
                    <span class="category-count">${tests.length}</span>
                </div>
                <div class="category-tests" style="display: none;">
                    ${tests.map(test => `
                        <div class="test-item" data-test="${test.id}" title="${test.description}">
                            <span class="test-label">${test.label}</span>
                        </div>
                    `).join('')}
                </div>
            </div>
        `;
    }

    html += '</div>';
    container.innerHTML = html;

    // Bind category expand/collapse
    container.querySelectorAll('.category-header').forEach(header => {
        header.addEventListener('click', () => {
            const category = header.parentElement;
            if (category) {
                const tests = category.querySelector('.category-tests') as HTMLElement;
                const icon = header.querySelector('.expand-icon');
                if (tests && icon) {
                    const isExpanded = tests.style.display !== 'none';
                    tests.style.display = isExpanded ? 'none' : 'block';
                    icon.classList.toggle('codicon-chevron-right', isExpanded);
                    icon.classList.toggle('codicon-chevron-down', !isExpanded);
                }
            }
        });
    });

    // Bind test item clicks
    container.querySelectorAll('.test-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const testId = item.getAttribute('data-test');
            if (testId) {
                vscode.postMessage({ type: 'testClick', testId });
            }
        });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
```

### `extensions/quantlab/webview/resources/statsCatalog.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Stats test catalog for Resources panel (lightweight metadata only)
 *--------------------------------------------------------------------------------------------*/

export type StatsCategory =
    | 'descriptive'
    | 'stationarity'
    | 'distribution'
    | 'dependence'
    | 'volatility'
    | 'regression'
    | 'risk';

export interface StatsTestMeta {
    id: string;
    label: string;
    description: string;
}

export const STATS_CATALOG: Record<StatsCategory, StatsTestMeta[]> = {
    descriptive: [
        { id: 'summary', label: 'Summary Statistics', description: 'Mean, std, skewness, kurtosis, percentiles' },
        { id: 'returns', label: 'Returns Analysis', description: 'Log returns, simple returns, cumulative' },
        { id: 'rolling', label: 'Rolling Statistics', description: 'Rolling mean, std, correlations' }
    ],
    stationarity: [
        { id: 'adf', label: 'ADF Test', description: 'Augmented Dickey-Fuller unit root test' },
        { id: 'kpss', label: 'KPSS Test', description: 'Kwiatkowski-Phillips-Schmidt-Shin test' },
        { id: 'pp', label: 'Phillips-Perron', description: 'Phillips-Perron unit root test' },
        { id: 'zivot', label: 'Zivot-Andrews', description: 'Structural break unit root test' },
        { id: 'variance-ratio', label: 'Variance Ratio', description: 'Lo-MacKinlay variance ratio test' }
    ],
    distribution: [
        { id: 'normality', label: 'Normality Tests', description: 'Jarque-Bera, Shapiro-Wilk, Anderson-Darling' },
        { id: 'ks', label: 'KS Test', description: 'Kolmogorov-Smirnov goodness of fit' },
        { id: 'qq', label: 'Q-Q Analysis', description: 'Quantile-quantile plots and analysis' },
        { id: 'tail', label: 'Tail Analysis', description: 'Extreme value analysis, GPD fitting' }
    ],
    dependence: [
        { id: 'correlation', label: 'Correlation Matrix', description: 'Pearson, Spearman, Kendall correlations' },
        { id: 'granger', label: 'Granger Causality', description: 'Granger causality tests' },
        { id: 'cointegration', label: 'Cointegration', description: 'Engle-Granger, Johansen tests' },
        { id: 'acf-pacf', label: 'ACF/PACF', description: 'Autocorrelation and partial autocorrelation' },
        { id: 'ljung-box', label: 'Ljung-Box', description: 'Serial correlation test' }
    ],
    volatility: [
        { id: 'garch', label: 'GARCH Models', description: 'GARCH(1,1), EGARCH, GJR-GARCH' },
        { id: 'realized', label: 'Realized Volatility', description: 'Realized variance, bipower variation' },
        { id: 'regime', label: 'Regime Detection', description: 'Markov switching volatility models' },
        { id: 'leverage', label: 'Leverage Effect', description: 'Asymmetric volatility analysis' }
    ],
    regression: [
        { id: 'ols', label: 'OLS Regression', description: 'Ordinary least squares with diagnostics' },
        { id: 'robust', label: 'Robust Regression', description: 'Huber, bisquare M-estimators' },
        { id: 'quantile', label: 'Quantile Regression', description: 'Regression at different quantiles' },
        { id: 'rolling-reg', label: 'Rolling Regression', description: 'Time-varying coefficients' },
        { id: 'pca', label: 'PCA Analysis', description: 'Principal component analysis' }
    ],
    risk: [
        { id: 'var', label: 'Value at Risk', description: 'Historical, parametric, Monte Carlo VaR' },
        { id: 'es', label: 'Expected Shortfall', description: 'CVaR / Expected Shortfall' },
        { id: 'drawdown', label: 'Drawdown Analysis', description: 'Max drawdown, drawdown duration' },
        { id: 'sharpe', label: 'Risk-Adjusted Returns', description: 'Sharpe, Sortino, Calmar ratios' },
        { id: 'beta', label: 'Beta Analysis', description: 'Market beta, rolling beta' }
    ]
};
```

### `extensions/quantlab/webview/resources/resources.css`

```css
/*---------------------------------------------------------------------------------------------
 *  Resources Panel Styles
 *--------------------------------------------------------------------------------------------*/

.resources-container {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--vscode-sideBar-background);
    color: var(--vscode-sideBar-foreground);
}

/* Section Switcher */
.section-switcher {
    display: flex;
    gap: 0;
    padding: 8px;
    background: var(--vscode-sideBarSectionHeader-background);
    border-bottom: 1px solid var(--vscode-sideBarSectionHeader-border);
}

.section-btn {
    flex: 1;
    padding: 6px 12px;
    border: 1px solid var(--vscode-button-border, transparent);
    background: transparent;
    color: var(--vscode-foreground);
    font-size: 12px;
    cursor: pointer;
    transition: background 0.1s, color 0.1s;
}

.section-btn:first-child {
    border-radius: 3px 0 0 3px;
}

.section-btn:last-child {
    border-radius: 0 3px 3px 0;
}

.section-btn:hover {
    background: var(--vscode-list-hoverBackground);
}

.section-btn.active {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border-color: var(--vscode-button-secondaryBackground);
}

/* Section Content */
.section-content {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
}

/* Strategy Tree */
.resource-tree {
    padding: 0 8px;
}

.tree-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 3px;
}

.tree-item:hover {
    background: var(--vscode-list-hoverBackground);
}

.tree-item .codicon {
    font-size: 14px;
    opacity: 0.8;
}

.item-label {
    font-size: 13px;
}

/* Stats Categories */
.stats-categories {
    padding: 0 4px;
}

.stats-category {
    margin-bottom: 2px;
}

.category-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
    font-weight: 500;
}

.category-header:hover {
    background: var(--vscode-list-hoverBackground);
}

.category-header .expand-icon {
    font-size: 12px;
    width: 16px;
}

.category-header .codicon:not(.expand-icon) {
    font-size: 14px;
    opacity: 0.8;
}

.category-label {
    flex: 1;
}

.category-count {
    font-size: 11px;
    opacity: 0.6;
    padding: 1px 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 10px;
}

/* Test Items */
.category-tests {
    padding-left: 28px;
}

.test-item {
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 3px;
    font-size: 12px;
}

.test-item:hover {
    background: var(--vscode-list-hoverBackground);
}

.test-label {
    color: var(--vscode-foreground);
}

/* Scrollbar */
.section-content::-webkit-scrollbar {
    width: 6px;
}

.section-content::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 3px;
}

.section-content::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground);
}
```

## Esbuild Configuration

### Modify `extensions/quantlab/esbuild-webview.mjs`

Add the resources entry point:

```javascript
// Find the entryPoints array and add:
'webview/resources/index.ts': 'resources'

// The full entry might look like:
const entryPoints = {
    'webview/action/index.ts': 'action',
    'webview/chart/index.ts': 'chart',
    'webview/trade/index.ts': 'trade',
    'webview/resources/index.ts': 'resources',  // NEW
};
```

## Test

1. Build webview: `npm run build:webview`
2. Open QuantLab
3. Click Resources icon in activity bar
4. Verify:
   - Two buttons appear at top: "Strategy" | "Pure Stats"
   - Clicking switches sections
   - Stats section shows 7 categories that expand/collapse
   - Clicking a test sends message (check DevTools)

## Dependencies
- Prompt 06 (ResourcesWebviewProvider) must be complete

## Next
Proceed to `08_Stats_Catalog.md`
