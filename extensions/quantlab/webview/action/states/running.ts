/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActionRunningState } from '../../../src/types/action';
import { escapeHtml, formatActionLabel, formatDuration } from '../utils';

interface RunningContext {
	postMessage: (message: unknown) => void;
}

let logCollapsed = false;

export function renderRunningState(container: HTMLElement, state: ActionRunningState, context: RunningContext): void {
	const actionLabel = formatActionLabel(state.action);
	const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
	const progress = Math.min(100, Math.max(0, state.progress));

	container.innerHTML = `
		<div class="action-page running-state">
			<header class="page-header">
				<div>
					<h1>${escapeHtml(actionLabel)}</h1>
					<p class="page-subtitle">Execution in progress.</p>
				</div>
				<div class="header-actions">
					<button class="btn btn-secondary" id="action-cancel">Cancel</button>
				</div>
			</header>
			<div class="divider"></div>

			<div class="status-row">
				<span class="status-pill status-running">RUNNING</span>
				<span class="status-meta">Run ID: ${escapeHtml(state.jobId)}</span>
			</div>

			<div class="progress-card">
				<div class="progress-bar">
					<div class="progress-fill" style="width: ${progress}%;"></div>
				</div>
				<div class="progress-meta">
					<span>${escapeHtml(state.message || 'Running...')}</span>
					<span>${escapeHtml(elapsed)}</span>
				</div>
			</div>

			<section class="section">
				<div class="section-header">
					<h2>Live Log</h2>
					<button class="btn btn-ghost" id="log-toggle">${logCollapsed ? 'Expand' : 'Collapse'}</button>
				</div>
				<div class="log-container ${logCollapsed ? 'collapsed' : 'expanded'}" id="log-container">
					${state.logs.map(entry => renderLogEntry(entry.timestamp, entry.message, entry.level)).join('')}
				</div>
			</section>
		</div>
	`;

	const cancelButton = container.querySelector<HTMLButtonElement>('#action-cancel');
	if (cancelButton) {
		cancelButton.addEventListener('click', () => {
			if (window.confirm('Cancel this job?')) {
				context.postMessage({ type: 'cancelJob', jobId: state.jobId });
			}
		});
	}

	const toggleButton = container.querySelector<HTMLButtonElement>('#log-toggle');
	if (toggleButton) {
		toggleButton.addEventListener('click', () => {
			logCollapsed = !logCollapsed;
			toggleButton.textContent = logCollapsed ? 'Expand' : 'Collapse';
			const logContainer = container.querySelector<HTMLElement>('#log-container');
			if (logContainer) {
				logContainer.classList.toggle('collapsed', logCollapsed);
				logContainer.classList.toggle('expanded', !logCollapsed);
			}
		});
	}

	const logContainer = container.querySelector<HTMLElement>('#log-container');
	const reduceMotion = document.documentElement.classList.contains('ql-reduced-motion');
	if (logContainer && !logCollapsed && !reduceMotion) {
		logContainer.scrollTop = logContainer.scrollHeight;
	}
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
