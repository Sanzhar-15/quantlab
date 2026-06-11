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

// VS Code webviews block window.confirm/prompt/alert, so cancel confirmation
// is an inline two-button row (megaudit H24). Module-level so the pending
// confirmation survives the full re-render on every progress/log event.
let cancelConfirmJobId: string | null = null;

export function renderRunningState(container: HTMLElement, state: ActionRunningState, context: RunningContext): void {
	const actionLabel = formatActionLabel(state.action);
	const elapsed = formatDuration(Date.now() - new Date(state.startedAt).getTime());
	const progress = Math.min(100, Math.max(0, state.progress));

	if (cancelConfirmJobId !== state.jobId) {
		cancelConfirmJobId = null;
	}
	const confirming = cancelConfirmJobId === state.jobId;

	container.innerHTML = `
		<div class="action-page running-state">
			<header class="page-header">
				<div>
					<h1>${escapeHtml(actionLabel)}</h1>
					<p class="page-subtitle">Execution in progress.</p>
				</div>
				<div class="header-actions">
					<span class="inline-confirm${confirming ? ' show' : ''}" id="cancel-confirm">
						<span class="inline-confirm-text">Cancel this job?</span>
						<button class="btn btn-danger" id="cancel-confirm-yes">Yes, cancel</button>
						<button class="btn btn-ghost" id="cancel-confirm-no">Keep running</button>
					</span>
					<button class="btn btn-secondary" id="action-cancel"${confirming ? ' hidden' : ''}>Cancel</button>
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
	const confirmRow = container.querySelector<HTMLElement>('#cancel-confirm');
	if (cancelButton && confirmRow) {
		cancelButton.addEventListener('click', () => {
			cancelConfirmJobId = state.jobId;
			cancelButton.hidden = true;
			confirmRow.classList.add('show');
		});

		const confirmYes = confirmRow.querySelector<HTMLButtonElement>('#cancel-confirm-yes');
		if (confirmYes) {
			confirmYes.addEventListener('click', () => {
				cancelConfirmJobId = null;
				confirmYes.disabled = true;
				confirmYes.textContent = 'Cancelling...';
				context.postMessage({ type: 'cancelJob', jobId: state.jobId });
			});
		}

		const confirmNo = confirmRow.querySelector<HTMLButtonElement>('#cancel-confirm-no');
		if (confirmNo) {
			confirmNo.addEventListener('click', () => {
				cancelConfirmJobId = null;
				confirmRow.classList.remove('show');
				cancelButton.hidden = false;
			});
		}
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
