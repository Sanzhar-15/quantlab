/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

interface VSCodeApi {
	postMessage(message: unknown): void;
	getState(): unknown;
	setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VSCodeApi;

const vscode = acquireVsCodeApi();

/**
 * Escape HTML special characters to prevent XSS
 */
function escapeHtml(str: string): string {
	const div = document.createElement('div');
	div.textContent = str;
	return div.innerHTML;
}

/**
 * Escape string for use in HTML attributes
 */
function escapeAttr(str: string): string {
	return str
		.replace(/&/g, '&amp;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

interface ColumnInfo {
	name: string;
	dtype: string;
	nullCount?: number;
	uniqueCount?: number;
	min?: number;
	max?: number;
}

interface VisualiseState {
	dataFile: string;
	columns: ColumnInfo[];
	chartType: 'line' | 'bar' | 'scatter' | 'histogram' | 'heatmap';
	selectedColumns: string[];
	preview?: {
		rows: number;
		sample: Record<string, unknown>[];
	};
}

let currentState: VisualiseState | null = null;

const CHART_TYPES = [
	{ id: 'line', label: 'Line', icon: 'graph-line' },
	{ id: 'bar', label: 'Bar', icon: 'graph' },
	{ id: 'scatter', label: 'Scatter', icon: 'graph-scatter' },
	{ id: 'histogram', label: 'Histogram', icon: 'graph' },
	{ id: 'heatmap', label: 'Heatmap', icon: 'symbol-color' }
];

function init(): void {
	const root = document.getElementById('visualise-root');
	if (!root) { return; }

	// Listen for messages from extension
	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'setState') {
			currentState = message.state;
			render();
		}
	});

	// Paint immediately: data inspection takes seconds (Python subprocess), and
	// without this first render the panel sits BLANK until the first setState
	// arrives -- the "loads empty until I click a chart type" bug.
	render();

	// Notify extension we're ready
	vscode.postMessage({ type: 'ready' });
}

function render(): void {
	const root = document.getElementById('visualise-root');
	if (!root) { return; }

	if (!currentState) {
		root.innerHTML = renderLoadingState();
		return;
	}

	root.innerHTML = renderMainView();
	bindEvents();
}

function renderLoadingState(): string {
	return `
		<div class="visualise-loading">
			<span class="codicon codicon-loading codicon-modifier-spin"></span>
			<p>Loading data...</p>
		</div>
	`;
}

function renderMainView(): string {
	if (!currentState) { return ''; }

	const state = currentState;

	return `
		<div class="visualise-container">
			<div class="visualise-sidebar">
				<div class="sidebar-section">
					<h3>Chart Type</h3>
					<div class="chart-type-list">
						${CHART_TYPES.map(ct => `
							<button class="chart-type-btn ${state.chartType === ct.id ? 'active' : ''}"
									data-chart-type="${ct.id}">
								<span class="codicon codicon-${ct.icon}"></span>
								${ct.label}
							</button>
						`).join('')}
					</div>
				</div>

				<div class="sidebar-section">
					<h3>Columns</h3>
					<div class="column-list">
						${state.columns.map(col => `
							<label class="column-item">
								<input type="checkbox"
										data-column="${escapeAttr(col.name)}"
										${state.selectedColumns.includes(col.name) ? 'checked' : ''}>
								<span class="column-name">${escapeHtml(col.name)}</span>
								<span class="column-type">${escapeHtml(col.dtype)}</span>
							</label>
						`).join('')}
					</div>
				</div>

				<div class="sidebar-section">
					<h3>Data Info</h3>
					<div class="data-info">
						<div class="info-row">
							<span class="label">File:</span>
							<span class="value" title="${escapeAttr(state.dataFile)}">${escapeHtml(getFileName(state.dataFile))}</span>
						</div>
						<div class="info-row">
							<span class="label">Rows:</span>
							<span class="value">${state.preview?.rows?.toLocaleString() ?? 'Unknown'}</span>
						</div>
						<div class="info-row">
							<span class="label">Columns:</span>
							<span class="value">${state.columns.length}</span>
						</div>
					</div>
				</div>
			</div>

			<div class="visualise-main">
				${renderChart()}
			</div>
		</div>
	`;
}

function renderChart(): string {
	if (!currentState || !currentState.preview) {
		return `
			<div class="chart-placeholder">
				<span class="codicon codicon-graph"></span>
				<p>No data available for visualization</p>
			</div>
		`;
	}

	if (currentState.selectedColumns.length === 0) {
		return `
			<div class="chart-placeholder">
				<span class="codicon codicon-graph"></span>
				<p>Select columns to visualize</p>
			</div>
		`;
	}

	// Render a simple ASCII/text-based preview
	// In a real implementation, this would use a charting library
	const state = currentState;
	const sample = state.preview.sample;
	const selectedCols = state.selectedColumns;

	// Build a simple table preview
	return `
		<div class="chart-area">
			<div class="chart-header">
				<h3>${state.chartType.charAt(0).toUpperCase() + state.chartType.slice(1)} Chart</h3>
				<span class="chart-subtitle">Showing ${selectedCols.map(c => escapeHtml(c)).join(', ')}</span>
			</div>
			<div class="chart-canvas">
				${renderSimpleVisualization(state.chartType, sample, selectedCols)}
			</div>
			<div class="chart-legend">
				${selectedCols.map((col, i) => `
					<div class="legend-item">
						<span class="legend-color" style="background: ${getColor(i)}"></span>
						<span class="legend-label">${escapeHtml(col)}</span>
					</div>
				`).join('')}
			</div>
		</div>
	`;
}

function renderSimpleVisualization(
	chartType: string,
	sample: Record<string, unknown>[],
	columns: string[]
): string {
	// Get numeric values for selected columns
	const data: number[][] = columns.map(col =>
		sample.map(row => {
			const val = row[col];
			return typeof val === 'number' ? val : parseFloat(String(val)) || 0;
		})
	);

	if (data.length === 0 || data[0].length === 0) {
		return '<p class="no-data">No numeric data to display</p>';
	}

	// Find min/max for scaling
	const allValues = data.flat();
	const min = Math.min(...allValues);
	const max = Math.max(...allValues);
	const range = max - min || 1;

	const height = 200;
	const width = Math.min(sample.length * 8, 600);

	if (chartType === 'line' || chartType === 'scatter') {
		// SVG line/scatter chart
		const points = data.map((series, seriesIdx) => {
			const pts = series.map((val, i) => {
				const x = (i / (series.length - 1 || 1)) * width;
				const y = height - ((val - min) / range) * height;
				return { x, y };
			});

			if (chartType === 'line') {
				const pathD = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
				return `<path d="${pathD}" fill="none" stroke="${getColor(seriesIdx)}" stroke-width="2"/>`;
			} else {
				return pts.map(p =>
					`<circle cx="${p.x}" cy="${p.y}" r="4" fill="${getColor(seriesIdx)}"/>`
				).join('');
			}
		});

		return `
			<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
				${points.join('')}
			</svg>
		`;
	}

	if (chartType === 'bar') {
		const barWidth = Math.max(4, (width / sample.length) - 2);
		const bars = data[0].map((val, i) => {
			const barHeight = ((val - min) / range) * height;
			const x = i * (barWidth + 2);
			const y = height - barHeight;
			return `<rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" fill="${getColor(0)}"/>`;
		});

		return `
			<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
				${bars.join('')}
			</svg>
		`;
	}

	if (chartType === 'histogram') {
		// Simple histogram with 10 bins
		const bins = 10;
		const binWidth = range / bins;
		const counts = new Array(bins).fill(0);

		data[0].forEach(val => {
			const binIdx = Math.min(Math.floor((val - min) / binWidth), bins - 1);
			counts[binIdx]++;
		});

		const maxCount = Math.max(...counts);
		const barW = width / bins - 2;

		const bars = counts.map((count, i) => {
			const barHeight = (count / maxCount) * height;
			const x = i * (barW + 2);
			const y = height - barHeight;
			return `<rect x="${x}" y="${y}" width="${barW}" height="${barHeight}" fill="${getColor(0)}"/>`;
		});

		return `
			<svg class="chart-svg" viewBox="0 0 ${width} ${height}" preserveAspectRatio="xMidYMid meet">
				${bars.join('')}
			</svg>
		`;
	}

	if (chartType === 'heatmap') {
		// Correlation heatmap for multiple columns
		if (columns.length < 2) {
			return `
				<div class="heatmap-placeholder">
					<p>Heatmap visualization requires 2+ numeric columns.</p>
					<p>Select additional columns to see correlation matrix.</p>
				</div>
			`;
		}

		// Calculate correlation matrix
		const correlations = calculateCorrelationMatrix(data, columns);
		const cellSize = Math.min(60, Math.floor(400 / columns.length));
		const gridSize = cellSize * columns.length;

		// Generate heatmap cells
		const cells: string[] = [];
		const labels: string[] = [];

		for (let i = 0; i < columns.length; i++) {
			for (let j = 0; j < columns.length; j++) {
				const corr = correlations[i][j];
				const color = getCorrelationColor(corr);
				const x = j * cellSize;
				const y = i * cellSize;
				cells.push(`
					<rect x="${x}" y="${y}" width="${cellSize - 1}" height="${cellSize - 1}"
						fill="${color}" rx="2">
						<title>${escapeHtml(columns[i])} vs ${escapeHtml(columns[j])}: ${corr.toFixed(3)}</title>
					</rect>
					<text x="${x + cellSize / 2}" y="${y + cellSize / 2 + 4}"
						text-anchor="middle" font-size="10" fill="${Math.abs(corr) > 0.5 ? '#fff' : '#000'}">
						${corr.toFixed(2)}
					</text>
				`);
			}
			// Row labels (left)
			labels.push(`
				<text x="-5" y="${i * cellSize + cellSize / 2 + 4}"
					text-anchor="end" font-size="10" fill="var(--vscode-foreground)">
					${escapeHtml(columns[i].slice(0, 8))}${columns[i].length > 8 ? '...' : ''}
				</text>
			`);
			// Column labels (top)
			labels.push(`
				<text x="${i * cellSize + cellSize / 2}" y="-5"
					text-anchor="middle" font-size="10" fill="var(--vscode-foreground)"
					transform="rotate(-45 ${i * cellSize + cellSize / 2} -5)">
					${escapeHtml(columns[i].slice(0, 8))}${columns[i].length > 8 ? '...' : ''}
				</text>
			`);
		}

		return `
			<svg class="chart-svg" viewBox="-80 -60 ${gridSize + 100} ${gridSize + 80}" preserveAspectRatio="xMidYMid meet">
				<g class="heatmap-cells">${cells.join('')}</g>
				<g class="heatmap-labels">${labels.join('')}</g>
				<!-- Color scale legend -->
				<defs>
					<linearGradient id="corrGradient" x1="0%" y1="0%" x2="100%" y2="0%">
						<stop offset="0%" style="stop-color:#2196f3"/>
						<stop offset="50%" style="stop-color:#fff"/>
						<stop offset="100%" style="stop-color:#f44336"/>
					</linearGradient>
				</defs>
				<rect x="${gridSize + 10}" y="0" width="20" height="${gridSize}" fill="url(#corrGradient)" rx="2"/>
				<text x="${gridSize + 35}" y="10" font-size="9" fill="var(--vscode-foreground)">+1</text>
				<text x="${gridSize + 35}" y="${gridSize / 2 + 4}" font-size="9" fill="var(--vscode-foreground)">0</text>
				<text x="${gridSize + 35}" y="${gridSize}" font-size="9" fill="var(--vscode-foreground)">-1</text>
			</svg>
		`;
	}

	return '<p class="no-data">Unsupported chart type</p>';
}

function getColor(index: number): string {
	const colors = [
		'#4fc3f7', // light blue
		'#81c784', // green
		'#ffb74d', // orange
		'#f06292', // pink
		'#ba68c8', // purple
		'#4dd0e1', // cyan
		'#aed581', // lime
		'#ff8a65'  // deep orange
	];
	return colors[index % colors.length];
}

/**
 * Calculate Pearson correlation matrix for given data columns
 */
function calculateCorrelationMatrix(data: number[][], columns: string[]): number[][] {
	const n = columns.length;
	const matrix: number[][] = [];

	for (let i = 0; i < n; i++) {
		matrix[i] = [];
		for (let j = 0; j < n; j++) {
			if (i === j) {
				matrix[i][j] = 1.0;
			} else if (j < i) {
				matrix[i][j] = matrix[j][i]; // Symmetric
			} else {
				matrix[i][j] = pearsonCorrelation(data[i], data[j]);
			}
		}
	}

	return matrix;
}

/**
 * Calculate Pearson correlation coefficient between two arrays
 */
function pearsonCorrelation(x: number[], y: number[]): number {
	const n = Math.min(x.length, y.length);
	if (n === 0) { return 0; }

	let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0;

	for (let i = 0; i < n; i++) {
		sumX += x[i];
		sumY += y[i];
		sumXY += x[i] * y[i];
		sumX2 += x[i] * x[i];
		sumY2 += y[i] * y[i];
	}

	const numerator = n * sumXY - sumX * sumY;
	const denominator = Math.sqrt((n * sumX2 - sumX * sumX) * (n * sumY2 - sumY * sumY));

	if (denominator === 0) { return 0; }
	return numerator / denominator;
}

/**
 * Get color for correlation value (-1 to +1)
 * Blue for negative, white for zero, red for positive
 */
function getCorrelationColor(corr: number): string {
	// Clamp to [-1, 1]
	corr = Math.max(-1, Math.min(1, corr));

	if (corr >= 0) {
		// White to Red
		const intensity = Math.round(255 * (1 - corr));
		return `rgb(255, ${intensity}, ${intensity})`;
	} else {
		// White to Blue
		const intensity = Math.round(255 * (1 + corr));
		return `rgb(${intensity}, ${intensity}, 255)`;
	}
}

function getFileName(path: string): string {
	return path.split(/[/\\]/).pop() || path;
}

function bindEvents(): void {
	// Chart type buttons
	document.querySelectorAll('.chart-type-btn').forEach(btn => {
		btn.addEventListener('click', () => {
			const chartType = (btn as HTMLButtonElement).dataset.chartType;
			if (chartType) {
				vscode.postMessage({ type: 'changeChart', chartType });
			}
		});
	});

	// Column checkboxes
	document.querySelectorAll('.column-item input').forEach(input => {
		input.addEventListener('change', () => {
			const selected: string[] = [];
			document.querySelectorAll('.column-item input:checked').forEach(cb => {
				const col = (cb as HTMLInputElement).dataset.column;
				if (col) { selected.push(col); }
			});
			vscode.postMessage({
				type: 'updateConfig',
				config: { selectedColumns: selected }
			});
		});
	});
}

document.addEventListener('DOMContentLoaded', init);
