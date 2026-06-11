/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Stats View Webview Script

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

interface StatsState {
	type: 'idle' | 'configuration' | 'running' | 'results' | 'error';
	testId?: string;
	testName?: string;
	dataFile?: string;
	columns?: Array<{ name: string; dtype: string }>;
	selectedColumns?: string[];
	parameters?: Record<string, unknown>;
	schema?: unknown;
	validation?: { isValid: boolean; errors: string[] };
	progress?: number;
	message?: string;
	result?: unknown;
	error?: string;
	durationMs?: number;
}

let currentState: StatsState = { type: 'idle' };

// M132: effective data-source summary (or the no-source refusal notice)
// sent by the provider alongside every setState.
interface DataSourceInfo {
	label?: string;
	notice?: string;
}
let dataSourceInfo: DataSourceInfo | undefined;

// M132 symbol picker state.
let symbolList: Array<{ symbol: string; name: string }> | undefined;
let symbolLoadError: string | undefined;
let symbolsRequested = false;

function init(): void {
	const root = document.getElementById('stats-root');
	if (!root) { return; }

	// Listen for messages from extension
	window.addEventListener('message', event => {
		const message = event.data;
		if (message.type === 'setState') {
			currentState = message.state;
			dataSourceInfo = message.dataSource;
			render();
		} else if (message.type === 'symbols') {
			if (message.error) {
				symbolLoadError = message.error;
				symbolList = undefined;
			} else {
				symbolList = message.symbols;
				symbolLoadError = undefined;
			}
			// Targeted update -- a full render() would wipe the user's
			// in-progress input text.
			updateSymbolPickerDom();
		}
	});

	// Notify extension we're ready
	vscode.postMessage({ type: 'ready' });
}

function render(): void {
	const root = document.getElementById('stats-root');
	if (!root) { return; }

	switch (currentState.type) {
		case 'idle':
			root.innerHTML = renderIdleState();
			break;
		case 'configuration':
			root.innerHTML = renderConfigurationState();
			bindConfigurationEvents();
			break;
		case 'running':
			root.innerHTML = renderRunningState();
			bindRunningEvents();
			break;
		case 'results':
			root.innerHTML = renderResultsState();
			bindResultsEvents();
			break;
		case 'error':
			root.innerHTML = renderErrorState();
			bindErrorEvents();
			break;
	}
}

function renderIdleState(): string {
	return `
		<div class="stats-idle">
			<span class="codicon codicon-beaker"></span>
			<p>Select a statistical test from the Resources panel to begin.</p>
		</div>
	`;
}

function symbolPickerStatusText(): string {
	if (symbolLoadError) { return symbolLoadError; }
	if (symbolList) { return `${symbolList.length} symbols available`; }
	if (symbolsRequested) { return 'Loading symbols...'; }
	return '';
}

function symbolOptionsHtml(): string {
	if (!symbolList) { return ''; }
	return symbolList.map(s =>
		`<option value="${escapeAttr(s.symbol)}">${escapeHtml(s.name)}</option>`
	).join('');
}

/** M132: refresh the datalist + status line in place (keeps input focus/text). */
function updateSymbolPickerDom(): void {
	const options = document.getElementById('symbol-options');
	if (options) {
		options.innerHTML = symbolOptionsHtml();
	}
	const status = document.getElementById('symbol-picker-status');
	if (status) {
		status.textContent = symbolPickerStatusText();
		status.className = symbolLoadError
			? 'symbol-picker-status error'
			: 'symbol-picker-status';
	}
}

function renderDataSourceSection(): string {
	const label = dataSourceInfo?.label;
	const notice = dataSourceInfo?.notice;
	const statusError = symbolLoadError ? ' error' : '';

	return `
		<div class="config-section data-source-section">
			<h3>Data Source</h3>
			${label ? `<p class="data-source-current">${escapeHtml(label)}</p>` : ''}
			${notice ? `
				<div class="data-source-notice">
					<p>${escapeHtml(notice)}</p>
				</div>
			` : ''}
			<div class="symbol-picker">
				<input id="symbol-input" list="symbol-options"
						placeholder="Server symbol (e.g. AAPL)" />
				<datalist id="symbol-options">${symbolOptionsHtml()}</datalist>
				<button id="use-symbol-btn" class="secondary">Use Symbol</button>
			</div>
			<p id="symbol-picker-status" class="symbol-picker-status${statusError}">${escapeHtml(symbolPickerStatusText())}</p>
		</div>
	`;
}

function renderConfigurationState(): string {
	const state = currentState;
	const isValid = state.validation?.isValid ?? false;
	const errors = state.validation?.errors ?? [];

	return `
		<div class="stats-configuration">
			<h2>${escapeHtml(state.testName || 'Configure Test')}</h2>
			${renderDataSourceSection()}

			<div class="config-section">
				<h3>Select Columns</h3>
				<div class="column-list">
					${(state.columns || []).map(col => `
						<label class="column-item">
							<input type="checkbox"
									data-column="${escapeAttr(col.name)}"
									${state.selectedColumns?.includes(col.name) ? 'checked' : ''}>
							<span class="column-name">${escapeHtml(col.name)}</span>
							<span class="column-type">(${escapeHtml(col.dtype)})</span>
						</label>
					`).join('')}
				</div>
			</div>

			${errors.length > 0 ? `
				<div class="validation-errors">
					${errors.map(e => `<p class="error">${escapeHtml(e)}</p>`).join('')}
				</div>
			` : ''}

			<div class="actions">
				<button id="run-btn" class="primary" ${!isValid ? 'disabled' : ''}>
					<span class="codicon codicon-play"></span>
					Run Test
				</button>
			</div>
		</div>
	`;
}

function renderRunningState(): string {
	const state = currentState;
	const progress = state.progress ?? 0;
	const message = state.message ?? 'Processing...';

	return `
		<div class="stats-running">
			<h2>${escapeHtml(state.testName || 'Running Test')}</h2>
			<div class="progress-container">
				<div class="progress-bar" style="width: ${progress}%"></div>
			</div>
			<p class="progress-message">${escapeHtml(message)}</p>
			<p class="progress-percent">${Math.round(progress)}%</p>
			<button id="cancel-btn" class="secondary">
				<span class="codicon codicon-stop"></span>
				Cancel
			</button>
		</div>
	`;
}

interface StatsResult {
	testName?: string;
	statistic?: number;
	pValue?: number | null;
	conclusion?: string;
	interpretation?: string;
	criticalValues?: Record<string, number>;
	details?: Record<string, unknown>;
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) { return 'N/A'; }
	if (typeof value === 'number') {
		return Number.isInteger(value) ? String(value) : value.toFixed(6);
	}
	if (typeof value === 'boolean') { return value ? 'Yes' : 'No'; }
	return String(value);
}

function renderCriticalValuesTable(criticalValues: Record<string, number>, statistic?: number): string {
	const entries = Object.entries(criticalValues);
	if (entries.length === 0) { return ''; }

	const rows = entries.map(([level, cv]) => {
		const absStatistic = statistic !== undefined ? Math.abs(statistic) : undefined;
		const absCv = Math.abs(cv);
		const significant = absStatistic !== undefined && absStatistic > absCv;
		const indicator = significant ? '<span class="significant">*</span>' : '';
		return `<tr>
			<td>${escapeHtml(level)}</td>
			<td>${cv.toFixed(4)}</td>
			<td>${indicator}</td>
		</tr>`;
	}).join('');

	return `
		<div class="critical-values">
			<h3>Critical Values</h3>
			<table class="results-table">
				<thead><tr><th>Level</th><th>Critical Value</th><th></th></tr></thead>
				<tbody>${rows}</tbody>
			</table>
		</div>
	`;
}

function renderDetailsTable(details: Record<string, unknown>): string {
	const entries = Object.entries(details);
	if (entries.length === 0) { return ''; }

	const rows = entries.map(([key, value]) => {
		const label = key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').trim();
		const displayLabel = label.charAt(0).toUpperCase() + label.slice(1);
		return `<tr>
			<td>${escapeHtml(displayLabel)}</td>
			<td>${escapeHtml(formatValue(value))}</td>
		</tr>`;
	}).join('');

	return `
		<div class="details-section">
			<h3>Details</h3>
			<table class="results-table">
				<tbody>${rows}</tbody>
			</table>
		</div>
	`;
}

function renderResultsState(): string {
	const state = currentState;
	const result = state.result as StatsResult | undefined;
	const durationMs = state.durationMs;
	const durationStr = durationMs !== undefined ? `${(durationMs / 1000).toFixed(1)}s` : '';

	return `
		<div class="stats-results">
			<h2>${escapeHtml(result?.testName || 'Test Results')}</h2>
			${durationStr ? `<p class="duration">Completed in ${escapeHtml(durationStr)}</p>` : ''}

			<div class="result-summary">
				<div class="result-item">
					<span class="label">Test Statistic:</span>
					<span class="value">${result?.statistic?.toFixed(4) ?? 'N/A'}</span>
				</div>
				<div class="result-item">
					<span class="label">P-Value:</span>
					<span class="value ${result?.pValue !== null && result?.pValue !== undefined && result.pValue < 0.05 ? 'significant' : ''}">${result?.pValue?.toFixed(6) ?? 'N/A'}</span>
				</div>
			</div>

			${result?.criticalValues ? renderCriticalValuesTable(result.criticalValues, result.statistic) : ''}

			<div class="conclusion">
				<h3>Conclusion</h3>
				<p>${escapeHtml(result?.conclusion || 'No conclusion available.')}</p>
			</div>

			${result?.interpretation ? `
				<div class="interpretation">
					<h3>Interpretation</h3>
					<p>${escapeHtml(result.interpretation)}</p>
				</div>
			` : ''}

			${result?.details ? renderDetailsTable(result.details) : ''}

			<div class="actions">
				<button id="back-btn" class="secondary">
					<span class="codicon codicon-arrow-left"></span>
					Back to Configuration
				</button>
			</div>
		</div>
	`;
}

function renderErrorState(): string {
	const state = currentState;
	return `
		<div class="stats-error">
			<span class="codicon codicon-error"></span>
			<h2>Error</h2>
			<p>${escapeHtml(state.error || 'An unknown error occurred.')}</p>
			<button id="retry-btn" class="primary">
				<span class="codicon codicon-refresh"></span>
				Try Again
			</button>
		</div>
	`;
}

function bindConfigurationEvents(): void {
	// Column checkboxes
	document.querySelectorAll('.column-item input').forEach(input => {
		input.addEventListener('change', () => {
			const selected: string[] = [];
			document.querySelectorAll('.column-item input:checked').forEach(cb => {
				const col = (cb as HTMLInputElement).dataset.column;
				if (col) { selected.push(col); }
			});
			vscode.postMessage({ type: 'updateConfig', config: { columns: selected } });
		});
	});

	// Run button
	document.getElementById('run-btn')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'runTest' });
	});

	// M132 symbol picker
	const symbolInput = document.getElementById('symbol-input') as HTMLInputElement | null;
	const useSymbolBtn = document.getElementById('use-symbol-btn');

	const requestSymbols = (): void => {
		if (symbolsRequested) { return; }
		symbolsRequested = true;
		vscode.postMessage({ type: 'loadSymbols' });
		updateSymbolPickerDom();
	};

	const submitSymbol = (): void => {
		const value = symbolInput?.value.trim();
		if (!value) { return; }
		vscode.postMessage({ type: 'setSymbolSource', symbol: value });
	};

	symbolInput?.addEventListener('focus', requestSymbols);
	symbolInput?.addEventListener('keydown', e => {
		if (e.key === 'Enter') {
			submitSymbol();
		}
	});
	useSymbolBtn?.addEventListener('click', submitSymbol);
}

function bindRunningEvents(): void {
	document.getElementById('cancel-btn')?.addEventListener('click', () => {
		vscode.postMessage({ type: 'cancel' });
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

document.addEventListener('DOMContentLoaded', init);
