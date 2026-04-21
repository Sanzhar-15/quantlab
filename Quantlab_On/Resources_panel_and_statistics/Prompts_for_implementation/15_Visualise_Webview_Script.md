# Prompt 15: Visualise Webview Frontend

## Objective
Create the webview frontend for data visualization with table and Plotly charts.

## Context
The VisualiseViewProvider (Prompt 14) hosts this webview. This script renders data tables and interactive charts.

## Files to Create

### `extensions/quantlab/webview/visualise/index.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Visualise View Webview Script
 *--------------------------------------------------------------------------------------------*/

declare const Plotly: typeof import('plotly.js-dist-min');

interface VSCodeApi {
    postMessage(message: unknown): void;
    getState(): unknown;
    setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

interface ColumnInfo {
    name: string;
    dtype: string;
    nullCount: number;
    uniqueCount: number;
    min?: number;
    max?: number;
}

interface DataFrameResult {
    columns: ColumnInfo[];
    data: Record<string, unknown[]>;
    rowCount: number;
}

interface VisualiseState {
    filePath: string;
    fileName: string;
    fileType: string;
    columns: ColumnInfo[];
    selectedColumns: string[];
    chartType: 'table' | 'line' | 'scatter' | 'histogram' | 'heatmap';
    data: DataFrameResult | null;
    isLoading: boolean;
    error: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────────────

let currentState: VisualiseState | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

function init(): void {
    window.addEventListener('message', event => {
        const message = event.data;
        if (message.type === 'setState') {
            currentState = message.state;
            render();
        }
    });

    vscode.postMessage({ type: 'ready' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering
// ─────────────────────────────────────────────────────────────────────────────

function render(): void {
    const root = document.getElementById('visualise-root');
    if (!root || !currentState) return;

    root.innerHTML = `
        <div class="visualise-container">
            ${renderHeader()}
            ${renderToolbar()}
            <div class="visualise-content">
                ${renderSidebar()}
                <div class="visualise-main">
                    ${currentState.isLoading ? renderLoading() :
                      currentState.error ? renderError() :
                      renderContent()}
                </div>
            </div>
        </div>
    `;

    bindEvents();

    // Render chart if not table view
    if (currentState.data && currentState.chartType !== 'table') {
        requestAnimationFrame(() => renderChart());
    }
}

function renderHeader(): string {
    return `
        <div class="visualise-header">
            <div class="file-info">
                <span class="codicon codicon-file"></span>
                <span class="file-name">${currentState!.fileName}</span>
                <span class="file-type">${currentState!.fileType.toUpperCase()}</span>
                ${currentState!.data ? `<span class="row-count">${currentState!.data.rowCount.toLocaleString()} rows</span>` : ''}
            </div>
            <div class="header-actions">
                <button id="export-btn" class="icon-btn" title="Export">
                    <span class="codicon codicon-export"></span>
                </button>
            </div>
        </div>
    `;
}

function renderToolbar(): string {
    const chartTypes = [
        { id: 'table', icon: 'table', label: 'Table' },
        { id: 'line', icon: 'graph-line', label: 'Line' },
        { id: 'scatter', icon: 'graph-scatter', label: 'Scatter' },
        { id: 'histogram', icon: 'graph', label: 'Histogram' },
        { id: 'heatmap', icon: 'symbol-color', label: 'Heatmap' }
    ];

    return `
        <div class="visualise-toolbar">
            <div class="chart-type-selector">
                ${chartTypes.map(ct => `
                    <button class="chart-type-btn ${currentState!.chartType === ct.id ? 'active' : ''}"
                            data-chart="${ct.id}"
                            title="${ct.label}">
                        <span class="codicon codicon-${ct.icon}"></span>
                    </button>
                `).join('')}
            </div>
        </div>
    `;
}

function renderSidebar(): string {
    const columns = currentState!.columns;
    const selected = new Set(currentState!.selectedColumns);

    return `
        <div class="visualise-sidebar">
            <div class="sidebar-header">
                <span>Columns</span>
                <span class="col-count">${selected.size}/${columns.length}</span>
            </div>
            <div class="column-list">
                ${columns.map(col => `
                    <label class="column-item">
                        <input type="checkbox"
                               value="${col.name}"
                               ${selected.has(col.name) ? 'checked' : ''}>
                        <span class="col-name" title="${col.name}">${col.name}</span>
                        <span class="col-dtype">${col.dtype}</span>
                    </label>
                `).join('')}
            </div>
        </div>
    `;
}

function renderLoading(): string {
    return `
        <div class="loading-state">
            <span class="codicon codicon-loading codicon-modifier-spin"></span>
            <p>Loading data...</p>
        </div>
    `;
}

function renderError(): string {
    return `
        <div class="error-state">
            <span class="codicon codicon-error"></span>
            <p>${currentState!.error}</p>
            <button id="retry-btn" class="primary">Retry</button>
        </div>
    `;
}

function renderContent(): string {
    if (currentState!.chartType === 'table') {
        return renderTable();
    }
    return `<div id="chart-container"></div>`;
}

function renderTable(): string {
    const data = currentState!.data;
    if (!data) return '<p>No data</p>';

    const columns = currentState!.selectedColumns.filter(c => c in data.data);
    if (columns.length === 0) return '<p>Select columns to display</p>';

    const rows = Math.min(data.rowCount, 100); // Show first 100 rows

    let html = `
        <div class="data-table-container">
            <table class="data-table">
                <thead>
                    <tr>
                        <th class="row-num">#</th>
                        ${columns.map(col => `<th title="${col}">${col}</th>`).join('')}
                    </tr>
                </thead>
                <tbody>
    `;

    for (let i = 0; i < rows; i++) {
        html += '<tr>';
        html += `<td class="row-num">${i + 1}</td>`;
        for (const col of columns) {
            const val = data.data[col][i];
            html += `<td>${formatValue(val)}</td>`;
        }
        html += '</tr>';
    }

    html += `
                </tbody>
            </table>
            ${data.rowCount > 100 ? `<p class="truncation-note">Showing 100 of ${data.rowCount.toLocaleString()} rows</p>` : ''}
        </div>
    `;

    return html;
}

function formatValue(val: unknown): string {
    if (val === null || val === undefined) return '<span class="null-value">null</span>';
    if (typeof val === 'number') {
        if (Number.isInteger(val)) return val.toLocaleString();
        return val.toFixed(4);
    }
    return String(val);
}

// ─────────────────────────────────────────────────────────────────────────────
// Charts
// ─────────────────────────────────────────────────────────────────────────────

function renderChart(): void {
    const container = document.getElementById('chart-container');
    if (!container || !currentState?.data) return;

    const data = currentState.data;
    const columns = currentState.selectedColumns.filter(c => c in data.data);

    if (columns.length === 0) {
        container.innerHTML = '<p class="chart-hint">Select columns to visualize</p>';
        return;
    }

    const layout: Partial<Plotly.Layout> = {
        paper_bgcolor: 'transparent',
        plot_bgcolor: 'transparent',
        font: { color: getComputedStyle(document.body).getPropertyValue('--vscode-foreground') },
        margin: { t: 30, r: 30, b: 50, l: 60 },
        showlegend: columns.length > 1
    };

    const config: Partial<Plotly.Config> = {
        responsive: true,
        displayModeBar: true,
        modeBarButtonsToRemove: ['lasso2d', 'select2d']
    };

    let traces: Plotly.Data[] = [];

    switch (currentState.chartType) {
        case 'line':
            traces = columns.map(col => ({
                y: data.data[col] as number[],
                name: col,
                type: 'scatter',
                mode: 'lines'
            }));
            break;

        case 'scatter':
            if (columns.length >= 2) {
                traces = [{
                    x: data.data[columns[0]] as number[],
                    y: data.data[columns[1]] as number[],
                    type: 'scatter',
                    mode: 'markers',
                    name: `${columns[0]} vs ${columns[1]}`
                }];
                layout.xaxis = { title: columns[0] };
                layout.yaxis = { title: columns[1] };
            } else {
                traces = [{
                    y: data.data[columns[0]] as number[],
                    type: 'scatter',
                    mode: 'markers',
                    name: columns[0]
                }];
            }
            break;

        case 'histogram':
            traces = columns.map(col => ({
                x: data.data[col] as number[],
                name: col,
                type: 'histogram',
                opacity: 0.7
            }));
            layout.barmode = 'overlay';
            break;

        case 'heatmap':
            if (columns.length >= 2) {
                // Compute correlation matrix
                const matrix = computeCorrelationMatrix(data.data, columns);
                traces = [{
                    z: matrix,
                    x: columns,
                    y: columns,
                    type: 'heatmap',
                    colorscale: 'RdBu',
                    zmin: -1,
                    zmax: 1
                }];
            }
            break;
    }

    Plotly.newPlot(container, traces, layout, config);
}

function computeCorrelationMatrix(data: Record<string, unknown[]>, columns: string[]): number[][] {
    const n = columns.length;
    const matrix: number[][] = [];

    for (let i = 0; i < n; i++) {
        matrix[i] = [];
        for (let j = 0; j < n; j++) {
            matrix[i][j] = pearsonCorrelation(
                data[columns[i]] as number[],
                data[columns[j]] as number[]
            );
        }
    }

    return matrix;
}

function pearsonCorrelation(x: number[], y: number[]): number {
    const n = Math.min(x.length, y.length);
    if (n === 0) return 0;

    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

    for (let i = 0; i < n; i++) {
        if (x[i] == null || y[i] == null) continue;
        sumX += x[i];
        sumY += y[i];
        sumXY += x[i] * y[i];
        sumX2 += x[i] * x[i];
        sumY2 += y[i] * y[i];
    }

    const num = n * sumXY - sumX * sumY;
    const den = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

    return den === 0 ? 0 : num / den;
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Binding
// ─────────────────────────────────────────────────────────────────────────────

function bindEvents(): void {
    // Chart type buttons
    document.querySelectorAll('.chart-type-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const chartType = btn.getAttribute('data-chart');
            vscode.postMessage({ type: 'changeChart', chartType });
        });
    });

    // Column checkboxes
    document.querySelectorAll('.column-item input').forEach(input => {
        input.addEventListener('change', () => {
            const selected: string[] = [];
            document.querySelectorAll('.column-item input:checked').forEach(cb => {
                selected.push((cb as HTMLInputElement).value);
            });
            vscode.postMessage({ type: 'selectColumns', columns: selected });
        });
    });

    // Export button
    document.getElementById('export-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'export' });
    });

    // Retry button
    document.getElementById('retry-btn')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'requestData' });
    });
}

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);
```

### `extensions/quantlab/webview/visualise/visualise.css`

```css
/*---------------------------------------------------------------------------------------------
 *  Visualise View Styles
 *--------------------------------------------------------------------------------------------*/

body {
    margin: 0;
    padding: 0;
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-font-family);
    font-size: 13px;
    overflow: hidden;
}

.visualise-container {
    display: flex;
    flex-direction: column;
    height: 100vh;
}

/* Header */
.visualise-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 8px 16px;
    background: var(--vscode-sideBarSectionHeader-background);
    border-bottom: 1px solid var(--vscode-panel-border);
}

.file-info {
    display: flex;
    align-items: center;
    gap: 8px;
}

.file-name {
    font-weight: 500;
}

.file-type {
    font-size: 11px;
    padding: 2px 6px;
    background: var(--vscode-badge-background);
    color: var(--vscode-badge-foreground);
    border-radius: 3px;
}

.row-count {
    font-size: 12px;
    opacity: 0.7;
}

.icon-btn {
    background: transparent;
    border: none;
    color: var(--vscode-foreground);
    padding: 4px 8px;
    cursor: pointer;
    border-radius: 3px;
}

.icon-btn:hover {
    background: var(--vscode-toolbar-hoverBackground);
}

/* Toolbar */
.visualise-toolbar {
    display: flex;
    padding: 8px 16px;
    border-bottom: 1px solid var(--vscode-panel-border);
}

.chart-type-selector {
    display: flex;
    gap: 4px;
}

.chart-type-btn {
    padding: 6px 10px;
    background: transparent;
    border: 1px solid var(--vscode-input-border);
    color: var(--vscode-foreground);
    border-radius: 3px;
    cursor: pointer;
}

.chart-type-btn:hover {
    background: var(--vscode-list-hoverBackground);
}

.chart-type-btn.active {
    background: var(--vscode-button-secondaryBackground);
    border-color: var(--vscode-button-secondaryBackground);
}

/* Content Layout */
.visualise-content {
    display: flex;
    flex: 1;
    overflow: hidden;
}

/* Sidebar */
.visualise-sidebar {
    width: 200px;
    border-right: 1px solid var(--vscode-panel-border);
    display: flex;
    flex-direction: column;
}

.sidebar-header {
    display: flex;
    justify-content: space-between;
    padding: 8px 12px;
    font-weight: 500;
    border-bottom: 1px solid var(--vscode-panel-border);
}

.col-count {
    font-size: 11px;
    opacity: 0.6;
}

.column-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px 0;
}

.column-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 12px;
    cursor: pointer;
}

.column-item:hover {
    background: var(--vscode-list-hoverBackground);
}

.col-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
}

.col-dtype {
    font-size: 10px;
    opacity: 0.6;
}

/* Main Area */
.visualise-main {
    flex: 1;
    overflow: auto;
    padding: 16px;
}

/* Loading / Error States */
.loading-state,
.error-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    gap: 12px;
}

.loading-state .codicon {
    font-size: 32px;
    color: var(--vscode-progressBar-background);
}

.error-state .codicon {
    font-size: 32px;
    color: var(--vscode-errorForeground);
}

/* Data Table */
.data-table-container {
    overflow: auto;
    max-height: 100%;
}

.data-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12px;
}

.data-table th,
.data-table td {
    padding: 6px 12px;
    text-align: left;
    border-bottom: 1px solid var(--vscode-panel-border);
    white-space: nowrap;
}

.data-table th {
    background: var(--vscode-sideBarSectionHeader-background);
    font-weight: 500;
    position: sticky;
    top: 0;
}

.data-table tr:hover {
    background: var(--vscode-list-hoverBackground);
}

.row-num {
    color: var(--vscode-descriptionForeground);
    font-size: 11px;
    width: 50px;
}

.null-value {
    color: var(--vscode-descriptionForeground);
    font-style: italic;
}

.truncation-note {
    margin-top: 12px;
    font-size: 12px;
    opacity: 0.7;
    text-align: center;
}

/* Chart Container */
#chart-container {
    height: 100%;
    min-height: 400px;
}

.chart-hint {
    text-align: center;
    opacity: 0.7;
    margin-top: 100px;
}

/* Scrollbar */
.column-list::-webkit-scrollbar,
.data-table-container::-webkit-scrollbar {
    width: 8px;
    height: 8px;
}

.column-list::-webkit-scrollbar-thumb,
.data-table-container::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background);
    border-radius: 4px;
}

button.primary {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 8px 16px;
    border-radius: 4px;
    cursor: pointer;
}

button.primary:hover {
    background: var(--vscode-button-hoverBackground);
}
```

## Esbuild Configuration

### Modify `extensions/quantlab/esbuild-webview.mjs`

Add the visualise entry point:

```javascript
// Add to entryPoints:
'webview/visualise/index.ts': 'visualise'
```

## Test

1. Build webview: `npm run build:webview`
2. Open a CSV/Parquet/XLSX file
3. Click "Visualise" button
4. Verify:
   - Data table renders with column data
   - Column selection works
   - Chart types (line, scatter, histogram, heatmap) work
   - Export button saves CSV

## Dependencies
- Prompt 14 (VisualiseViewProvider) must be complete
- Plotly library installed

## Next
Proceed to `16_Package_Json_Updates.md`
