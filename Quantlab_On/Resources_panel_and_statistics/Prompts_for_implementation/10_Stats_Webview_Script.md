# Prompt 10: Stats Webview Frontend

## Objective
Create the webview frontend for the Stats view showing configuration and results.

## Context
The StatsViewProvider (Prompt 09) hosts this webview. This script renders the configuration form and results display.

## Files to Create

### `extensions/quantlab/webview/stats/index.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Stats View Webview Script
 *--------------------------------------------------------------------------------------------*/

import type { StatsState, StatsTestDefinition, StatsParameterDefinition } from './types';

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

let currentState: StatsState | null = null;
let allTests: Array<{ id: string; label: string; category: string }> = [];

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

function init(): void {
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'setState') {
            currentState = message.state;
            allTests = message.allTests || [];
            render();
        }
    });

    vscode.postMessage({ type: 'ready' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function render(): void {
    const root = document.getElementById('stats-root');
    if (!root || !currentState) return;

    switch (currentState.type) {
        case 'idle':
            root.innerHTML = renderIdleState();
            break;
        case 'configuration':
            root.innerHTML = renderConfigurationState(currentState);
            bindConfigurationEvents();
            break;
        case 'running':
            root.innerHTML = renderRunningState(currentState);
            bindRunningEvents();
            break;
        case 'results':
            root.innerHTML = renderResultsState(currentState);
            bindResultsEvents();
            break;
        case 'error':
            root.innerHTML = renderErrorState(currentState);
            bindErrorEvents();
            break;
    }
}

function renderIdleState(): string {
    return `
        <div class="stats-idle">
            <div class="idle-icon">
                <span class="codicon codicon-beaker"></span>
            </div>
            <h2>Select a Statistical Test</h2>
            <p>Choose a test from the Resources panel to begin analysis.</p>
        </div>
    `;
}

function renderConfigurationState(state: StatsConfigurationState): string {
    const schema = state.schema;

    return `
        <div class="stats-config">
            <div class="config-header">
                <div class="test-selector">
                    <select id="test-select">
                        ${allTests.map(t => `
                            <option value="${t.id}" ${t.id === state.testId ? 'selected' : ''}>
                                ${t.label}
                            </option>
                        `).join('')}
                    </select>
                </div>
                <p class="test-description">${schema.description}</p>
            </div>

            <div class="config-section">
                <h3>Columns</h3>
                <p class="section-hint">
                    Required: ${formatColumnRequirement(schema.requiredColumns)}
                </p>
                <div class="column-list">
                    ${state.columns.map(col => `
                        <label class="column-item ${isCompatibleType(col.dtype, schema.requiredColumns.types) ? '' : 'incompatible'}">
                            <input type="checkbox"
                                   value="${col.name}"
                                   ${state.selectedColumns.includes(col.name) ? 'checked' : ''}
                                   ${isCompatibleType(col.dtype, schema.requiredColumns.types) ? '' : 'disabled'}>
                            <span class="col-name">${col.name}</span>
                            <span class="col-type">${col.dtype}</span>
                        </label>
                    `).join('')}
                </div>
            </div>

            ${schema.parameters.length > 0 ? `
                <div class="config-section">
                    <h3>Parameters</h3>
                    <div class="params-grid">
                        ${schema.parameters.map(p => renderParameter(p, state.parameters[p.id])).join('')}
                    </div>
                </div>
            ` : ''}

            <div class="config-actions">
                ${state.validation && !state.validation.isValid ? `
                    <div class="validation-errors">
                        ${state.validation.errors.map(e => `<p class="error">${e}</p>`).join('')}
                    </div>
                ` : ''}
                <button id="run-btn" class="primary" ${state.validation?.isValid ? '' : 'disabled'}>
                    <span class="codicon codicon-play"></span>
                    Run Test
                </button>
            </div>
        </div>
    `;
}

function renderParameter(param: StatsParameterDefinition, value: unknown): string {
    const id = `param-${param.id}`;

    switch (param.type) {
        case 'number':
            return `
                <div class="param-field">
                    <label for="${id}">${param.label}</label>
                    <input type="number" id="${id}"
                           value="${value ?? param.default}"
                           min="${param.min ?? ''}"
                           max="${param.max ?? ''}"
                           data-param="${param.id}">
                    ${param.description ? `<small>${param.description}</small>` : ''}
                </div>
            `;

        case 'select':
            return `
                <div class="param-field">
                    <label for="${id}">${param.label}</label>
                    <select id="${id}" data-param="${param.id}">
                        ${param.options?.map(opt => `
                            <option value="${opt.value}" ${opt.value === String(value) ? 'selected' : ''}>
                                ${opt.label}
                            </option>
                        `).join('')}
                    </select>
                    ${param.description ? `<small>${param.description}</small>` : ''}
                </div>
            `;

        case 'boolean':
            return `
                <div class="param-field param-checkbox">
                    <label>
                        <input type="checkbox" id="${id}" data-param="${param.id}"
                               ${value ? 'checked' : ''}>
                        ${param.label}
                    </label>
                    ${param.description ? `<small>${param.description}</small>` : ''}
                </div>
            `;

        case 'array':
            return `
                <div class="param-field">
                    <label for="${id}">${param.label}</label>
                    <input type="text" id="${id}"
                           value="${Array.isArray(value) ? value.join(', ') : param.default}"
                           data-param="${param.id}"
                           data-type="array">
                    ${param.description ? `<small>${param.description}</small>` : ''}
                </div>
            `;

        default:
            return '';
    }
}

function renderRunningState(state: StatsRunningState): string {
    return `
        <div class="stats-running">
            <div class="running-animation">
                <span class="codicon codicon-loading codicon-modifier-spin"></span>
            </div>
            <h2>${state.testName}</h2>
            <div class="progress-bar">
                <div class="progress-fill" style="width: ${state.progress}%"></div>
            </div>
            <p class="progress-message">${state.message}</p>
            <button id="cancel-btn" class="secondary">
                <span class="codicon codicon-stop"></span>
                Cancel
            </button>
        </div>
    `;
}

function bindRunningEvents(): void {
    document.getElementById('cancel-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'cancel' });
    });
}

function renderResultsState(state: StatsResultsState): string {
    const result = state.result;

    return `
        <div class="stats-results">
            <div class="results-header">
                <h2>${result.testName}</h2>
                <button id="back-btn" class="secondary">
                    <span class="codicon codicon-arrow-left"></span>
                    Back to Configuration
                </button>
            </div>

            <div class="results-summary">
                <div class="stat-card">
                    <span class="stat-label">Test Statistic</span>
                    <span class="stat-value">${result.statistic.toFixed(4)}</span>
                </div>
                <div class="stat-card">
                    <span class="stat-label">p-value</span>
                    <span class="stat-value ${result.pValue < 0.05 ? 'significant' : ''}">${result.pValue.toFixed(4)}</span>
                </div>
                ${result.criticalValues ? `
                    <div class="stat-card">
                        <span class="stat-label">Critical Values</span>
                        <div class="critical-values">
                            ${Object.entries(result.criticalValues).map(([k, v]) =>
                                `<span>${k}: ${(v as number).toFixed(3)}</span>`
                            ).join('')}
                        </div>
                    </div>
                ` : ''}
            </div>

            <div class="results-conclusion">
                <h3>Conclusion</h3>
                <p class="conclusion-text">${result.conclusion}</p>
                <p class="interpretation-text">${result.interpretation}</p>
            </div>

            ${result.visualizations && result.visualizations.length > 0 ? `
                <div class="results-visualizations">
                    <h3>Visualizations</h3>
                    <div id="viz-container"></div>
                </div>
            ` : ''}

            <div class="results-details">
                <h3>Details</h3>
                <pre>${JSON.stringify(result.details, null, 2)}</pre>
            </div>

            <div class="results-meta">
                <small>Completed in ${state.durationMs}ms</small>
            </div>
        </div>
    `;
}

function renderErrorState(state: StatsErrorState): string {
    return `
        <div class="stats-error">
            <div class="error-icon">
                <span class="codicon codicon-error"></span>
            </div>
            <h2>Error</h2>
            <p class="error-message">${state.error}</p>
            ${state.recoverable ? `
                <button id="retry-btn" class="primary">
                    <span class="codicon codicon-refresh"></span>
                    Try Again
                </button>
            ` : ''}
        </div>
    `;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Binding
// ─────────────────────────────────────────────────────────────────────────────

function bindConfigurationEvents(): void {
    // Test selector
    document.getElementById('test-select')?.addEventListener('change', (e) => {
        const testId = (e.target as HTMLSelectElement).value;
        vscode.postMessage({ type: 'switchTest', testId });
    });

    // Column checkboxes
    document.querySelectorAll('.column-item input').forEach(input => {
        input.addEventListener('change', () => {
            const selected: string[] = [];
            document.querySelectorAll('.column-item input:checked').forEach(cb => {
                selected.push((cb as HTMLInputElement).value);
            });
            vscode.postMessage({
                type: 'updateConfig',
                config: { columns: selected }
            });
        });
    });

    // Parameters
    document.querySelectorAll('[data-param]').forEach(input => {
        input.addEventListener('change', () => {
            const paramId = (input as HTMLElement).dataset.param!;
            let value: unknown;

            if (input instanceof HTMLInputElement) {
                if (input.type === 'checkbox') {
                    value = input.checked;
                } else if (input.type === 'number') {
                    value = parseFloat(input.value);
                } else if (input.dataset.type === 'array') {
                    value = input.value.split(',').map(s => parseFloat(s.trim())).filter(n => !isNaN(n));
                } else {
                    value = input.value;
                }
            } else if (input instanceof HTMLSelectElement) {
                value = input.value;
            }

            vscode.postMessage({
                type: 'updateConfig',
                config: { parameters: { [paramId]: value } }
            });
        });
    });

    // Run button
    document.getElementById('run-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'runTest' });
    });
}

function bindResultsEvents(): void {
    document.getElementById('back-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'backToConfig' });
    });
}

function bindErrorEvents(): void {
    document.getElementById('retry-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'backToConfig' });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function formatColumnRequirement(req: { count: number | '1+' | '2+'; types: string[] }): string {
    let countStr = '';
    if (typeof req.count === 'number') {
        countStr = `exactly ${req.count}`;
    } else {
        countStr = req.count === '1+' ? 'at least 1' : 'at least 2';
    }
    return `${countStr} column(s) of type ${req.types.join(' or ')}`;
}

function isCompatibleType(dtype: string, validTypes: string[]): boolean {
    return validTypes.includes(dtype);
}

// Type imports (inline for webview)
interface StatsConfigurationState {
    type: 'configuration';
    testId: string;
    testName: string;
    dataFile: string;
    columns: Array<{ name: string; dtype: string }>;
    selectedColumns: string[];
    parameters: Record<string, unknown>;
    schema: StatsTestDefinition;
    validation?: { isValid: boolean; errors: string[] };
}

interface StatsRunningState {
    type: 'running';
    testId: string;
    testName: string;
    progress: number;
    message: string;
}

interface StatsResultsState {
    type: 'results';
    testId: string;
    result: StatsTestResult;
    durationMs: number;
}

interface StatsErrorState {
    type: 'error';
    testId: string;
    error: string;
    recoverable: boolean;
}

interface StatsTestResult {
    testId: string;
    testName: string;
    statistic: number;
    pValue: number;
    criticalValues?: Record<string, number>;
    conclusion: string;
    interpretation: string;
    details: Record<string, unknown>;
    visualizations?: unknown[];
}

interface StatsTestDefinition {
    id: string;
    label: string;
    description: string;
    category: string;
    requiredColumns: { count: number | '1+' | '2+'; types: string[] };
    parameters: StatsParameterDefinition[];
}

interface StatsParameterDefinition {
    id: string;
    label: string;
    type: string;
    default: unknown;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    description?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
```

### `extensions/quantlab/webview/stats/stats.css`

```css
/*---------------------------------------------------------------------------------------------
 *  Stats View Styles
 *--------------------------------------------------------------------------------------------*/

:root {
    --bg-primary: var(--vscode-editor-background);
    --fg-primary: var(--vscode-editor-foreground);
    --accent: var(--vscode-button-background);
    --border: var(--vscode-panel-border);
}

body {
    margin: 0;
    padding: 16px;
    background: var(--bg-primary);
    color: var(--fg-primary);
    font-family: var(--vscode-font-family);
    font-size: 13px;
}

/* Idle State */
.stats-idle {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60vh;
    text-align: center;
}

.idle-icon .codicon {
    font-size: 48px;
    opacity: 0.4;
}

.stats-idle h2 {
    margin: 16px 0 8px;
    font-weight: 500;
}

.stats-idle p {
    opacity: 0.7;
}

/* Configuration */
.stats-config {
    max-width: 800px;
    margin: 0 auto;
}

.config-header {
    margin-bottom: 24px;
}

.test-selector select {
    width: 100%;
    padding: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
    font-size: 14px;
}

.test-description {
    margin: 8px 0 0;
    opacity: 0.8;
}

.config-section {
    margin-bottom: 24px;
}

.config-section h3 {
    margin: 0 0 8px;
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.8;
}

.section-hint {
    margin: 0 0 12px;
    font-size: 12px;
    opacity: 0.6;
}

/* Column List */
.column-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.column-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    background: var(--vscode-input-background);
    border-radius: 4px;
    cursor: pointer;
}

.column-item:hover {
    background: var(--vscode-list-hoverBackground);
}

.column-item.incompatible {
    opacity: 0.5;
    cursor: not-allowed;
}

.col-name {
    flex: 1;
}

.col-type {
    font-size: 11px;
    padding: 2px 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 3px;
}

/* Parameters */
.params-grid {
    display: grid;
    gap: 16px;
}

.param-field {
    display: flex;
    flex-direction: column;
    gap: 4px;
}

.param-field label {
    font-weight: 500;
}

.param-field input,
.param-field select {
    padding: 8px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border);
    border-radius: 4px;
}

.param-field small {
    font-size: 11px;
    opacity: 0.6;
}

.param-checkbox {
    flex-direction: row;
    align-items: center;
}

.param-checkbox label {
    display: flex;
    align-items: center;
    gap: 8px;
}

/* Actions */
.config-actions {
    margin-top: 24px;
    padding-top: 16px;
    border-top: 1px solid var(--border);
}

.validation-errors {
    margin-bottom: 12px;
}

.validation-errors .error {
    margin: 4px 0;
    color: var(--vscode-errorForeground);
    font-size: 12px;
}

button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 16px;
    border: none;
    border-radius: 4px;
    font-size: 13px;
    cursor: pointer;
}

button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}

button.primary:hover {
    background: var(--vscode-button-hoverBackground);
}

button.primary:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}

button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
}

/* Running State */
.stats-running {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60vh;
    text-align: center;
}

.running-animation .codicon {
    font-size: 48px;
    color: var(--accent);
}

.progress-bar {
    width: 300px;
    height: 4px;
    background: var(--vscode-progressBar-background);
    border-radius: 2px;
    margin: 24px 0 12px;
    overflow: hidden;
}

.progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.3s ease;
}

.progress-message {
    opacity: 0.7;
}

/* Results State */
.stats-results {
    max-width: 900px;
    margin: 0 auto;
}

.results-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 24px;
}

.results-header h2 {
    margin: 0;
}

.results-summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
}

.stat-card {
    padding: 16px;
    background: var(--vscode-input-background);
    border-radius: 8px;
    text-align: center;
}

.stat-label {
    display: block;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    opacity: 0.7;
    margin-bottom: 8px;
}

.stat-value {
    font-size: 24px;
    font-weight: 600;
}

.stat-value.significant {
    color: var(--vscode-charts-green);
}

.critical-values {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
}

.results-conclusion,
.results-visualizations,
.results-details {
    margin-bottom: 24px;
    padding: 16px;
    background: var(--vscode-input-background);
    border-radius: 8px;
}

.results-conclusion h3,
.results-visualizations h3,
.results-details h3 {
    margin: 0 0 12px;
    font-size: 14px;
}

.conclusion-text {
    font-weight: 500;
    margin-bottom: 8px;
}

.interpretation-text {
    opacity: 0.8;
}

.results-details pre {
    margin: 0;
    padding: 12px;
    background: var(--vscode-textCodeBlock-background);
    border-radius: 4px;
    overflow-x: auto;
    font-size: 12px;
}

.results-meta {
    text-align: right;
    opacity: 0.5;
}

/* Error State */
.stats-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 60vh;
    text-align: center;
}

.error-icon .codicon {
    font-size: 48px;
    color: var(--vscode-errorForeground);
}

.error-message {
    max-width: 400px;
    color: var(--vscode-errorForeground);
}
```

## Esbuild Configuration

### Modify `extensions/quantlab/esbuild-webview.mjs`

Add the stats entry point:

```javascript
// Add to entryPoints:
'webview/stats/index.ts': 'stats'
```

## Test

1. Build webview: `npm run build:webview`
2. Open a data file, click Action, select a test
3. Verify:
   - Configuration UI shows with column checkboxes
   - Parameters render correctly
   - Validation errors appear when requirements not met
   - Run button enables when valid

## Dependencies
- Prompt 09 (StatsViewProvider) must be complete

## Next
Proceed to `11_Stats_Engine.md`
