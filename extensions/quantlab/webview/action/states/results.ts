/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActionResultsState, StatsResult } from '../../../src/types/action';
import { escapeHtml, formatActionLabel, formatDuration, formatRunType } from '../utils';

interface ResultsContext {
	postMessage: (message: unknown) => void;
}

export function renderResultsState(container: HTMLElement, state: ActionResultsState, context: ResultsContext): void {
	// Check if this is a stats resource result
	if (state.resourceId && state.statsResult && state.status === 'completed') {
		renderStatsResults(container, state, state.statsResult, context);
		return;
	}

	const actionLabel = formatActionLabel(state.action);
	const statusLabel = formatRunType(state.status);
	const duration = formatDuration(state.durationMs);
	const metrics = state.metrics ? Object.entries(state.metrics) : [];
	const hasArtifacts = Boolean(state.artifactPath);
	const logs = state.logs ?? [];
	const hasLogs = logs.length > 0;
	const showLogsAction = Boolean(state.error) || hasLogs;
	const rerunLabel = state.status === 'failed' ? 'Retry' : 'Re-run';
	const isOfflineResource = state.resourceId?.startsWith('offline-');

	container.innerHTML = `
		<div class="action-page results-state">
			<header class="page-header">
				<div>
					<h1>${escapeHtml(actionLabel)} Results</h1>
					<p class="page-subtitle">Review metrics and next actions.</p>
				</div>
				<div class="header-actions">
					${!isOfflineResource ? `<button class="btn btn-secondary" id="action-rerun">${escapeHtml(rerunLabel)}</button>` : ''}
					<button class="btn btn-ghost" id="action-back">New Analysis</button>
				</div>
			</header>
			<div class="divider"></div>

			<div class="status-card status-${escapeHtml(state.status)}">
				<div>
					<div class="status-title">${escapeHtml(statusLabel)}</div>
					<div class="status-meta">Run ID: ${escapeHtml(state.runId)}</div>
				</div>
				<div class="status-meta">${duration ? `Duration: ${escapeHtml(duration)}` : ''}</div>
			</div>

			${state.error ? `
				<div class="callout error">
					<strong>Run error</strong>
					<span>${escapeHtml(state.error)}</span>
				</div>
			` : ''}
			${!hasArtifacts && !isOfflineResource ? `
				<div class="callout warning">
					<strong>Artifacts unavailable</strong>
					<span>Run artifacts were not found for this job.</span>
				</div>
			` : ''}

			<section class="section">
				<div class="section-header">
					<h2>Summary Metrics</h2>
					<span class="section-hint">Key outputs from this run.</span>
				</div>
				${metrics.length ? `
					<div class="metrics-grid">
						${metrics.map(([label, value]) => renderMetric(label, value)).join('')}
					</div>
				` : '<div class="empty-state">No metrics available for this run.</div>'}
			</section>

			${state.warnings && state.warnings.length ? `
				<section class="section">
					<div class="section-header">
						<h2>Warnings</h2>
					</div>
					<ul class="warning-list">
						${state.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('')}
					</ul>
				</section>
			` : ''}

			${state.error || hasLogs ? `
				<section class="section" id="action-logs">
					<div class="section-header">
						<h2>Logs</h2>
					</div>
					${hasLogs ? `
						<div class="log-container expanded">
							${logs.map(entry => renderLogEntry(entry.timestamp, entry.message, entry.level)).join('')}
						</div>
					` : '<div class="empty-state">Logs unavailable for this run.</div>'}
				</section>
			` : ''}

			<section class="section">
				<div class="section-header">
					<h2>Actions</h2>
				</div>
				<div class="action-buttons">
					${!isOfflineResource ? `<button class="btn btn-primary" id="action-view-chart" ${hasArtifacts ? '' : 'disabled'}>View in Chart</button>` : ''}
					${!isOfflineResource ? `<button class="btn btn-secondary" id="action-export" ${hasArtifacts ? '' : 'disabled'}>Export Results</button>` : ''}
					${showLogsAction ? '<button class="btn btn-ghost" id="action-view-logs">View Logs</button>' : ''}
					${!isOfflineResource ? '<button class="btn btn-ghost" id="action-pin">Pin Run</button>' : ''}
					${!isOfflineResource ? '<button class="btn btn-ghost" id="action-compare">Add to Compare</button>' : ''}
				</div>
			</section>
		</div>
	`;

	const rerunButton = container.querySelector<HTMLButtonElement>('#action-rerun');
	if (rerunButton) {
		rerunButton.addEventListener('click', () => {
			context.postMessage({ type: 'rerun', runId: state.runId });
		});
	}

	const backButton = container.querySelector<HTMLButtonElement>('#action-back');
	if (backButton) {
		backButton.addEventListener('click', () => {
			context.postMessage({ type: 'back' });
		});
	}

	const viewButton = container.querySelector<HTMLButtonElement>('#action-view-chart');
	if (viewButton && hasArtifacts) {
		viewButton.addEventListener('click', () => {
			context.postMessage({ type: 'viewInChart', runId: state.runId });
		});
	}

	const exportButton = container.querySelector<HTMLButtonElement>('#action-export');
	if (exportButton && hasArtifacts) {
		exportButton.addEventListener('click', () => {
			showExportPrompt(state.runId, context.postMessage);
		});
	}

	const logsButton = container.querySelector<HTMLButtonElement>('#action-view-logs');
	if (logsButton) {
		logsButton.addEventListener('click', () => {
			const logsSection = container.querySelector<HTMLElement>('#action-logs');
			if (logsSection) {
				logsSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
			}
		});
	}

	const pinButton = container.querySelector<HTMLButtonElement>('#action-pin');
	if (pinButton) {
		pinButton.addEventListener('click', () => {
			context.postMessage({ type: 'pinRun', runId: state.runId });
		});
	}

	const compareButton = container.querySelector<HTMLButtonElement>('#action-compare');
	if (compareButton) {
		compareButton.addEventListener('click', () => {
			context.postMessage({ type: 'addToCompare', runId: state.runId });
		});
		compareButton.addEventListener('dragover', event => {
			const runId = event.dataTransfer?.getData('application/quantlab-run');
			if (!runId) {
				return;
			}
			event.preventDefault();
			compareButton.classList.add('drop-target');
		});
		compareButton.addEventListener('dragleave', () => {
			compareButton.classList.remove('drop-target');
		});
		compareButton.addEventListener('drop', event => {
			event.preventDefault();
			compareButton.classList.remove('drop-target');
			const runId = event.dataTransfer?.getData('application/quantlab-run');
			if (runId) {
				context.postMessage({ type: 'addToCompare', runId });
			}
		});
	}
}

function renderStatsResults(container: HTMLElement, state: ActionResultsState, result: StatsResult, context: ResultsContext): void {
	const duration = formatDuration(state.durationMs);
	const isPositive = (result.conclusion.toLowerCase().includes('stationary') && !result.conclusion.toLowerCase().includes('non-stationary'))
		|| result.conclusion.toLowerCase().includes('cannot reject');
	const isNegative = result.conclusion.toLowerCase().includes('non-stationary')
		|| result.conclusion.toLowerCase().includes('non-normal')
		|| (result.conclusion.toLowerCase().includes('reject') && !result.conclusion.toLowerCase().includes('cannot reject'));
	const badgeClass = isPositive ? 'positive' : isNegative ? 'negative' : 'neutral';

	const criticalValues = result.criticalValues ? Object.entries(result.criticalValues) : [];

	container.innerHTML = `
		<div class="action-page results-state">
			<header class="page-header">
				<div>
					<h1>${escapeHtml(result.testName)}</h1>
					<p class="page-subtitle">Statistical test results.</p>
				</div>
				<div class="header-actions">
					<button class="btn btn-ghost" id="action-back">New Analysis</button>
				</div>
			</header>
			<div class="divider"></div>

			<section class="section">
				<div class="section-header">
					<h2>Conclusion</h2>
					${duration ? `<span class="section-hint">${escapeHtml(duration)}</span>` : ''}
				</div>
				<div>
					<span class="conclusion-badge ${badgeClass}">${escapeHtml(result.conclusion)}</span>
				</div>
			</section>

			<section class="section">
				<div class="section-header">
					<h2>Test Statistics</h2>
				</div>
				<table class="stats-results-table">
					<thead>
						<tr>
							<th>Metric</th>
							<th>Value</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>Test Statistic</td>
							<td>${Number.isFinite(result.statistic) ? result.statistic.toFixed(6) : 'N/A'}</td>
						</tr>
						<tr>
							<td>p-Value</td>
							<td>${result.pValue !== null && result.pValue !== undefined ? result.pValue.toFixed(6) : 'N/A'}</td>
						</tr>
						${criticalValues.map(([level, val]) => `
							<tr>
								<td>Critical Value (${escapeHtml(level)})</td>
								<td>${Number.isFinite(val) ? val.toFixed(6) : 'N/A'}</td>
							</tr>
						`).join('')}
					</tbody>
				</table>
			</section>

			<section class="section">
				<div class="section-header">
					<h2>Interpretation</h2>
				</div>
				<div class="interpretation-block">
					${escapeHtml(result.interpretation)}
				</div>
			</section>

			${state.resourceMeta?.resultHints ? `
				<section class="section">
					<div class="section-header">
						<h2>Tips</h2>
					</div>
					<ul class="warning-list">
						${state.resourceMeta.resultHints.map(hint => `<li>${escapeHtml(hint)}</li>`).join('')}
					</ul>
				</section>
			` : ''}
		</div>
	`;

	const backButton = container.querySelector<HTMLButtonElement>('#action-back');
	if (backButton) {
		backButton.addEventListener('click', () => {
			context.postMessage({ type: 'back' });
		});
	}
}

function renderMetric(label: string, value: number): string {
	const formatted = Number.isFinite(value) ? value.toFixed(2) : String(value);
	return `
		<div class="metric-card">
			<div class="metric-label">${escapeHtml(label)}</div>
			<div class="metric-value">${escapeHtml(formatted)}</div>
		</div>
	`;
}

function renderLogEntry(timestamp: string, message: string, level?: string): string {
	const levelClass = level ? `log-${level}` : 'log-info';
	return `
		<div class="log-entry ${levelClass}">
			<span class="log-time">[${escapeHtml(timestamp)}]</span>
			<span class="log-message">${escapeHtml(message)}</span>
		</div>
	`;
}

function showExportPrompt(runId: string, postMessage: (message: unknown) => void): void {
	const format = window.prompt('Export format: json, csv, html', 'json');
	if (!format) {
		return;
	}

	const normalized = format.trim().toLowerCase();
	if (normalized !== 'json' && normalized !== 'csv' && normalized !== 'html') {
		window.alert('Unsupported format. Use json, csv, or html.');
		return;
	}

	postMessage({ type: 'exportResults', runId, format: normalized });
}
