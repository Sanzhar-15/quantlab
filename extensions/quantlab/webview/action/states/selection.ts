/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActionSelectionState, QuickActionType, StrategyInfo } from '../../../src/types/action';
import type { HistoryEntry } from '../../../src/types/history';
import { escapeHtml, formatRelativeTime, formatRunType, pickMetric } from '../utils';

const QUICK_ACTIONS: Array<{ type: QuickActionType; label: string; description: string }> = [
	{ type: 'backtest', label: 'Backtest', description: 'Run strategy on historical data' },
	{ type: 'optimize', label: 'Optimize', description: 'Search for best parameters' },
	{ type: 'monteCarlo', label: 'Monte Carlo', description: 'Simulate randomized runs' },
	{ type: 'wfa', label: 'WFA', description: 'Walk-forward validation' }
];

interface SelectionContext {
	strategy?: StrategyInfo;
	postMessage: (message: unknown) => void;
}

export function renderSelectionState(container: HTMLElement, state: ActionSelectionState, context: SelectionContext): void {
	const strategyValid = context.strategy?.isValid ?? true;
	const strategyMessage = context.strategy?.validationMessage;
	const quickActionsEnabled = strategyValid;
	const recentRuns = state.recentRuns ?? [];
	const allowedActions = new Set(state.quickActions ?? []);

	container.innerHTML = `
		<div class="action-page selection-state">
			<header class="page-header">
				<div>
					<h1>Action</h1>
					<p class="page-subtitle">Run tests and analyze results for ${escapeHtml(state.strategyPath || context.strategy?.path || '')}.</p>
				</div>
			</header>

			${!strategyValid ? `
				<div class="callout warning">
					<strong>Strategy validation required.</strong>
					<span>${escapeHtml(strategyMessage || 'Fix strategy issues to run actions.')}</span>
				</div>
			` : ''}

			<section class="section">
				<div class="section-header">
					<h2>Quick Actions</h2>
					<span class="section-hint">Defaults from global symbol and timeframe.</span>
				</div>
				<div class="quick-actions-grid">
				${QUICK_ACTIONS.filter(action => allowedActions.size === 0 || allowedActions.has(action.type)).map(action => `
						<button class="quick-action-card" data-action="${action.type}" ${quickActionsEnabled ? '' : 'disabled'}>
							<div class="quick-action-title">${escapeHtml(action.label)}</div>
							<div class="quick-action-desc">${escapeHtml(action.description)}</div>
						</button>
					`).join('')}
				</div>
				<p class="section-note">Need custom settings? Pick a test from the Resources panel.</p>
			</section>

			<section class="section">
				<div class="section-header">
					<h2>Resources</h2>
					<span class="section-hint">Select a template or test from the Resources panel.</span>
				</div>
				<div class="resource-callout">Resources panel opens automatically when you enter Action view.</div>
			</section>

			<section class="section">
				<div class="section-header">
					<h2>Recent Runs</h2>
					<span class="section-hint">Recent activity for this strategy.</span>
				</div>
				${renderRecentRuns(recentRuns)}
			</section>
		</div>
	`;

	container.querySelectorAll<HTMLButtonElement>('.quick-action-card').forEach(button => {
		button.addEventListener('click', () => {
			const action = button.getAttribute('data-action') as QuickActionType | null;
			if (!action) {
				return;
			}
			context.postMessage({ type: 'quickAction', action });
		});
	});

	container.querySelectorAll<HTMLButtonElement>('.recent-run-view').forEach(button => {
		button.addEventListener('click', () => {
			const runId = button.getAttribute('data-run-id');
			if (runId) {
				context.postMessage({ type: 'selectRun', runId });
			}
		});
	});

	container.querySelectorAll<HTMLButtonElement>('.recent-run-rerun').forEach(button => {
		button.addEventListener('click', () => {
			const runId = button.getAttribute('data-run-id');
			if (runId) {
				context.postMessage({ type: 'rerun', runId });
			}
		});
	});
}

function renderRecentRuns(runs: HistoryEntry[]): string {
	if (!runs.length) {
		return '<div class="empty-state">No recent runs for this strategy.</div>';
	}

	return `
		<ul class="recent-runs-list">
			${runs.map(run => renderRunItem(run)).join('')}
		</ul>
	`;
}

function renderRunItem(run: HistoryEntry): string {
	const metric = pickMetric(run.metrics);
	const relativeTime = formatRelativeTime(run.completedAt ?? run.startedAt);
	const statusClass = `status-${run.status}`;
	const statusLabel = formatRunType(run.status);
	const viewLabel = run.status === 'failed' ? 'View Logs' : 'View';
	const showRerun = run.status === 'completed';

	return `
		<li class="recent-run-item ${statusClass}">
			<div class="recent-run-main">
				<div class="recent-run-title">${escapeHtml(formatRunType(run.type))} - ${escapeHtml(run.id)}</div>
				<div class="recent-run-meta">
					<span class="status-pill ${statusClass}">${escapeHtml(statusLabel)}</span>
					<span>${escapeHtml(relativeTime)}</span>
					${metric ? `<span>${escapeHtml(metric.label)}: ${metric.value.toFixed(2)}</span>` : ''}
				</div>
			</div>
			<div class="recent-run-actions">
				<button class="btn btn-secondary recent-run-view" data-run-id="${escapeHtml(run.id)}">${viewLabel}</button>
				${showRerun ? `<button class="btn btn-ghost recent-run-rerun" data-run-id="${escapeHtml(run.id)}">Re-run</button>` : ''}
			</div>
		</li>
	`;
}
