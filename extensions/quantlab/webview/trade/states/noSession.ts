/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { RequirementsCheck } from '../../../src/types/trading';

interface NoSessionState {
	requirements: RequirementsCheck;
	requirementsPolicy: { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean };
}

interface NoSessionActions {
	postMessage: (message: unknown) => void;
}

export function renderNoSession(container: HTMLElement, state: NoSessionState, actions: NoSessionActions): void {
	const page = document.createElement('div');
	page.className = 'trade-page';

	const header = document.createElement('header');
	header.className = 'page-header';
	header.innerHTML = `
		<div>
			<h1>Trade</h1>
			<p class="page-subtitle">No active session. Start from the Trade panel.</p>
		</div>
		<div class="header-actions">
			<button class="btn btn-primary" data-action="open-panel">Open Trade Panel</button>
		</div>
	`;

	const card = document.createElement('section');
	card.className = 'card';

	const blocking = buildBlockingIssues(state.requirements, state.requirementsPolicy);
	if (blocking.length) {
		const alert = document.createElement('div');
		alert.className = 'callout warning';
		alert.textContent = `Resolve to enable live trading: ${blocking.join(' | ')}`;
		card.appendChild(alert);
	}

	const list = document.createElement('div');
	list.className = 'requirements-list';
	list.appendChild(buildRequirementRow('Strategy entrypoint', state.requirements.validStrategy, true));
	list.appendChild(buildComplexityRow(state.requirements.complexity));
	list.appendChild(buildRequirementRow('Broker configured', state.requirements.brokerConfigured, true));
	list.appendChild(buildRequirementRow('Backtest completed', state.requirements.hasBacktest, state.requirementsPolicy.requireBacktest));
	list.appendChild(buildRequirementRow('Paper trading completed', state.requirements.hasPaperTrading, state.requirementsPolicy.requirePaperTrading));
	list.appendChild(buildRequirementRow('Risk review confirmed', state.requirements.riskReviewed, state.requirementsPolicy.requireRiskReview));

	card.appendChild(list);

	page.appendChild(header);
	page.appendChild(card);
	container.appendChild(page);

	const button = header.querySelector<HTMLButtonElement>('button[data-action="open-panel"]');
	if (button) {
		button.setAttribute('aria-label', 'Open trade panel');
		button.addEventListener('click', () => actions.postMessage({ type: 'openTradePanel' }));
	}
}

function buildRequirementRow(label: string, met: boolean, required: boolean): HTMLElement {
	const row = document.createElement('div');
	row.className = `requirement-row ${met ? 'ok' : required ? 'blocked' : 'warn'}`;
	row.innerHTML = `
		<span class="req-status">${met ? 'OK' : required ? '!' : '?'}</span>
		<span class="req-label">${label}</span>
		<span class="req-meta">${required ? 'Required' : 'Recommended'}</span>
	`;
	return row;
}

function buildComplexityRow(level: RequirementsCheck['complexity']): HTMLElement {
	const row = document.createElement('div');
	const status = level === 'safe' ? 'ok' : level === 'partial' ? 'warn' : 'blocked';
	const label = level === 'safe' ? 'Safe' : level === 'partial' ? 'Partial' : 'View-Only';
	row.className = `requirement-row ${status}`;
	row.innerHTML = `
		<span class="req-status">${level === 'safe' ? 'OK' : level === 'partial' ? '!' : 'X'}</span>
		<span class="req-label">Complexity: ${label}</span>
		<span class="req-meta">Live trading</span>
	`;
	return row;
}

function buildBlockingIssues(requirements: RequirementsCheck, policy: NoSessionState['requirementsPolicy']): string[] {
	const issues: string[] = [];
	if (!requirements.validStrategy) {
		issues.push('strategy invalid');
	}
	if (!requirements.brokerConfigured) {
		issues.push('broker missing');
	}
	if (requirements.complexity === 'viewOnly') {
		issues.push('view-only complexity');
	}
	if (policy.requireBacktest && !requirements.hasBacktest) {
		issues.push('backtest required');
	}
	if (policy.requirePaperTrading && !requirements.hasPaperTrading) {
		issues.push('paper trading required');
	}
	if (policy.requireRiskReview && !requirements.riskReviewed) {
		issues.push('risk review required');
	}
	return issues;
}
