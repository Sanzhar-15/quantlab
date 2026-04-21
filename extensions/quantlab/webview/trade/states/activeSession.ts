/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActivityEntry, KillSwitchPolicy, Order, PerformanceMetrics, Position, RiskAlert, SessionInfo, TradeErrorState } from '../../../src/types/trading';

interface ActiveSessionState {
	session: SessionInfo;
	positions: Position[];
	orders: Order[];
	performance: PerformanceMetrics | null;
	activity: ActivityEntry[];
	heartbeat: { status: 'ok' | 'stale' | 'lost'; lastSeen: number } | null;
	riskAlerts: RiskAlert[];
	errorState: TradeErrorState | null;
	killSwitchPolicy: KillSwitchPolicy;
}

interface ActiveSessionActions {
	postMessage: (message: unknown) => void;
}

export function renderActiveSession(container: HTMLElement, state: ActiveSessionState, actions: ActiveSessionActions): void {
	const page = document.createElement('div');
	page.className = 'trade-page';

	page.appendChild(renderHeader(state, actions));
	page.appendChild(renderAlerts(state, actions));
	page.appendChild(renderSessionInfo(state, actions));
	page.appendChild(renderPerformance(state.performance));
	page.appendChild(renderPositions(state, actions));
	page.appendChild(renderOrders(state, actions));
	page.appendChild(renderActivity(state.activity));

	container.appendChild(page);
}

function renderHeader(state: ActiveSessionState, actions: ActiveSessionActions): HTMLElement {
	const header = document.createElement('header');
	header.className = 'page-header';

	const title = document.createElement('div');
	title.innerHTML = `
		<h1>Trade Session</h1>
		<p class="page-subtitle">${state.session.type === 'paper' ? 'Paper' : 'Live'} - ${state.session.symbol} ${state.session.timeframe}</p>
	`;

	const actionsWrap = document.createElement('div');
	actionsWrap.className = 'header-actions';

	const killSwitch = document.createElement('button');
	killSwitch.className = 'btn btn-danger';
	killSwitch.textContent = `Kill Switch - ${formatPolicy(state.killSwitchPolicy)}`;
	killSwitch.setAttribute('aria-label', `Kill switch (${formatPolicy(state.killSwitchPolicy)})`);
	killSwitch.addEventListener('click', () => actions.postMessage({ type: 'killSwitch', sessionId: state.session.id }));

	const viewChart = document.createElement('button');
	viewChart.className = 'btn btn-secondary';
	viewChart.textContent = 'View in Chart';
	viewChart.setAttribute('aria-label', 'View session in chart');
	viewChart.addEventListener('click', () => actions.postMessage({ type: 'viewInChart', sessionId: state.session.id }));

	actionsWrap.appendChild(viewChart);
	actionsWrap.appendChild(killSwitch);
	header.appendChild(title);
	header.appendChild(actionsWrap);

	return header;
}

function renderAlerts(state: ActiveSessionState, actions: ActiveSessionActions): HTMLElement {
	const wrapper = document.createElement('div');
	wrapper.className = 'alert-stack';
	wrapper.setAttribute('aria-live', 'polite');

	if (state.errorState) {
		const error = document.createElement('div');
		error.className = 'callout error';
		error.setAttribute('role', 'alert');
		const message = document.createElement('div');
		message.className = 'callout-message';
		message.textContent = state.errorState.message;
		error.appendChild(message);
		if (state.errorState.detail) {
			const detail = document.createElement('div');
			detail.className = 'callout-detail';
			detail.textContent = state.errorState.detail;
			error.appendChild(detail);
		}

		const actionRow = document.createElement('div');
		actionRow.className = 'callout-actions';

		const viewLogs = document.createElement('button');
		viewLogs.className = 'btn btn-ghost';
		viewLogs.textContent = 'View Logs';
		viewLogs.setAttribute('aria-label', 'View trade logs');
		viewLogs.addEventListener('click', () => actions.postMessage({ type: 'openTradeLogs', sessionId: state.session.id }));
		actionRow.appendChild(viewLogs);

		if (state.errorState.recoverable) {
			const retry = document.createElement('button');
			retry.className = 'btn btn-secondary';
			retry.textContent = 'Retry';
			retry.setAttribute('aria-label', 'Retry broker connection');
			retry.addEventListener('click', () => actions.postMessage({ type: 'retryBroker', sessionId: state.session.id }));
			actionRow.appendChild(retry);

			const settings = document.createElement('button');
			settings.className = 'btn btn-ghost';
			settings.textContent = 'Open Broker Settings';
			settings.setAttribute('aria-label', 'Open broker settings');
			settings.addEventListener('click', () => actions.postMessage({ type: 'openBrokerSettings' }));
			actionRow.appendChild(settings);
		} else {
			const restart = document.createElement('button');
			restart.className = 'btn btn-secondary';
			restart.textContent = 'Restart Session';
			restart.setAttribute('aria-label', 'Restart session');
			restart.addEventListener('click', () => actions.postMessage({ type: 'restartSession', sessionId: state.session.id }));
			actionRow.appendChild(restart);
		}

		error.appendChild(actionRow);
		wrapper.appendChild(error);
	}

	for (const alert of state.riskAlerts) {
		const banner = document.createElement('div');
		banner.className = 'callout warning';
		banner.setAttribute('role', 'status');
		banner.textContent = alert.message;
		wrapper.appendChild(banner);
	}

	return wrapper;
}

function renderSessionInfo(state: ActiveSessionState, actions: ActiveSessionActions): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const header = document.createElement('div');
	header.className = 'section-header';
	header.innerHTML = `
		<h2>Session</h2>
		<span class="section-hint">Heartbeat: ${formatHeartbeat(state.heartbeat)}</span>
	`;

	const grid = document.createElement('div');
	grid.className = 'info-grid';
	grid.appendChild(makeInfo('Status', capitalize(state.session.status)));
	grid.appendChild(makeInfo('Account', state.session.accountName));
	grid.appendChild(makeInfo('Started', new Date(state.session.startedAt).toLocaleString()));
	grid.appendChild(makeInfo('Strategy Hash', state.session.strategyHash));

	card.appendChild(header);
	card.appendChild(grid);

	const actionsRow = document.createElement('div');
	actionsRow.className = 'session-actions';
	const pause = document.createElement('button');
	pause.className = 'btn btn-secondary';
	pause.textContent = state.session.status === 'paused' ? 'Resume' : 'Pause';
	pause.setAttribute('aria-label', state.session.status === 'paused' ? 'Resume session' : 'Pause session');
	pause.addEventListener('click', () => actionsForPause(state, actions, pause));

	const stop = document.createElement('button');
	stop.className = 'btn btn-secondary';
	stop.textContent = 'Stop';
	stop.setAttribute('aria-label', 'Stop session');
	stop.addEventListener('click', () => actions.postMessage({ type: 'stopSession', sessionId: state.session.id }));

	const settings = document.createElement('button');
	settings.className = 'btn btn-ghost';
	settings.textContent = 'Session Settings';
	settings.setAttribute('aria-label', 'Open session settings');
	settings.addEventListener('click', () => actions.postMessage({ type: 'openSessionSettings', sessionId: state.session.id }));

	actionsRow.appendChild(pause);
	actionsRow.appendChild(stop);
	actionsRow.appendChild(settings);
	card.appendChild(actionsRow);

	return card;

	function actionsForPause(current: ActiveSessionState, currentActions: ActiveSessionActions, button: HTMLButtonElement): void {
		const type = current.session.status === 'paused' ? 'resumeSession' : 'pauseSession';
		button.disabled = true;
		currentActions.postMessage({ type, sessionId: current.session.id });
		setTimeout(() => {
			button.disabled = false;
		}, 800);
	}
}

function renderPerformance(performance: PerformanceMetrics | null): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const header = document.createElement('div');
	header.className = 'section-header';
	header.innerHTML = '<h2>Performance</h2><span class="section-hint">Session snapshot</span>';
	card.appendChild(header);

	const grid = document.createElement('div');
	grid.className = 'perf-grid';
	const metrics = performance ?? {
		sessionPnL: 0,
		todayPnL: 0,
		openPnL: 0,
		realizedPnL: 0,
		totalTrades: 0,
		winRate: 0,
		avgWin: 0,
		avgLoss: 0
	};

	grid.appendChild(makeMetric('Session P&L', metrics.sessionPnL));
	grid.appendChild(makeMetric('Today', metrics.todayPnL));
	grid.appendChild(makeMetric('Open', metrics.openPnL));
	grid.appendChild(makeMetric('Realized', metrics.realizedPnL));
	grid.appendChild(makeMetric('Trades', metrics.totalTrades, false));
	grid.appendChild(makeMetric('Win Rate', metrics.winRate, false, true));

	card.appendChild(grid);
	return card;
}

function renderPositions(state: ActiveSessionState, actions: ActiveSessionActions): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const header = document.createElement('div');
	header.className = 'section-header';
	header.innerHTML = '<h2>Positions</h2><span class="section-hint">Live exposure</span>';
	card.appendChild(header);

	if (!state.positions.length) {
		card.appendChild(emptyRow('No open positions.'));
		return card;
	}

	const table = document.createElement('table');
	table.className = 'data-table';
	table.innerHTML = `
		<thead>
			<tr>
				<th>Symbol</th>
				<th>Qty</th>
				<th>Avg</th>
				<th>Current</th>
				<th>Unrealized</th>
				<th>Action</th>
			</tr>
		</thead>
	`;
	const body = document.createElement('tbody');
	for (const position of state.positions) {
		const row = document.createElement('tr');
		row.innerHTML = `
			<td>${position.symbol}</td>
			<td>${position.quantity}</td>
			<td>$${position.avgPrice.toFixed(2)}</td>
			<td>$${position.currentPrice.toFixed(2)}</td>
			<td class="${position.unrealizedPnL >= 0 ? 'pos' : 'neg'}">${formatMoney(position.unrealizedPnL)}</td>
			<td></td>
		`;
		const actionCell = row.lastElementChild as HTMLTableCellElement;
		const close = document.createElement('button');
		close.className = 'btn btn-ghost';
		close.textContent = 'Close';
		close.setAttribute('aria-label', `Close position ${position.symbol}`);
		close.addEventListener('click', () => actions.postMessage({ type: 'closePosition', sessionId: state.session.id, symbol: position.symbol }));
		actionCell.appendChild(close);
		body.appendChild(row);
	}
	table.appendChild(body);
	card.appendChild(table);
	return card;
}

function renderOrders(state: ActiveSessionState, actions: ActiveSessionActions): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const header = document.createElement('div');
	header.className = 'section-header';
	header.innerHTML = '<h2>Open Orders</h2><span class="section-hint">Working orders</span>';
	card.appendChild(header);

	const openOrders = state.orders.filter(order => order.status === 'open' || order.status === 'partial' || order.status === 'pending');

	if (!openOrders.length) {
		card.appendChild(emptyRow('No open orders.'));
		return card;
	}

	const table = document.createElement('table');
	table.className = 'data-table';
	table.innerHTML = `
		<thead>
			<tr>
				<th>Symbol</th>
				<th>Side</th>
				<th>Qty</th>
				<th>Type</th>
				<th>Price</th>
				<th>Status</th>
				<th>Action</th>
			</tr>
		</thead>
	`;
	const body = document.createElement('tbody');
	for (const order of openOrders) {
		const row = document.createElement('tr');
		const priceLabel = order.price !== undefined ? `$${order.price.toFixed(2)}` : 'Market';
		row.innerHTML = `
			<td>${order.symbol}</td>
			<td>${order.side.toUpperCase()}</td>
			<td>${order.quantity}</td>
			<td>${order.type}</td>
			<td>${priceLabel}</td>
			<td>${order.status}</td>
			<td></td>
		`;
		const actionCell = row.lastElementChild as HTMLTableCellElement;
		const modify = document.createElement('button');
		modify.className = 'btn btn-ghost';
		modify.textContent = 'Modify';
		modify.setAttribute('aria-label', `Modify order ${order.id}`);
		modify.addEventListener('click', () => promptModify(order, state, actions));

		const cancel = document.createElement('button');
		cancel.className = 'btn btn-ghost';
		cancel.textContent = 'Cancel';
		cancel.setAttribute('aria-label', `Cancel order ${order.id}`);
		cancel.addEventListener('click', () => actions.postMessage({ type: 'cancelOrder', sessionId: state.session.id, orderId: order.id }));

		actionCell.appendChild(modify);
		actionCell.appendChild(cancel);
		body.appendChild(row);

		if (order.rejectionReason) {
			const reason = document.createElement('tr');
			reason.className = 'row-note';
			reason.innerHTML = `<td colspan="7">Rejected: ${order.rejectionReason}</td>`;
			body.appendChild(reason);
		}
	}
	table.appendChild(body);
	card.appendChild(table);
	return card;
}

function renderActivity(entries: ActivityEntry[]): HTMLElement {
	const card = document.createElement('section');
	card.className = 'card';

	const header = document.createElement('div');
	header.className = 'section-header';
	header.innerHTML = '<h2>Activity</h2><span class="section-hint">Recent events</span>';
	card.appendChild(header);

	if (!entries.length) {
		card.appendChild(emptyRow('No activity yet.'));
		return card;
	}

	const list = document.createElement('div');
	list.className = 'activity-list';
	for (const entry of entries.slice(0, 20)) {
		const item = document.createElement('div');
		item.className = 'activity-item';
		item.innerHTML = `
			<span class="activity-time">${new Date(entry.timestamp).toLocaleTimeString()}</span>
			<span class="activity-text">${entry.message}</span>
		`;
		list.appendChild(item);
	}
	card.appendChild(list);
	return card;
}

function formatHeartbeat(heartbeat: ActiveSessionState['heartbeat']): string {
	if (!heartbeat) {
		return 'pending';
	}
	switch (heartbeat.status) {
		case 'ok':
			return 'ok';
		case 'stale':
			return 'stale';
		case 'lost':
			return 'lost';
		default:
			return 'unknown';
	}
}

function makeInfo(label: string, value: string): HTMLElement {
	const item = document.createElement('div');
	item.className = 'info-item';
	item.innerHTML = `<span class="info-label">${label}</span><span class="info-value">${value}</span>`;
	return item;
}

function makeMetric(label: string, value: number, currency = true, percent = false): HTMLElement {
	const item = document.createElement('div');
	item.className = 'metric-item';
	const formatted = percent ? `${value.toFixed(1)}%` : currency ? formatMoney(value) : `${value}`;
	item.innerHTML = `<span class="metric-label">${label}</span><span class="metric-value ${value >= 0 ? 'pos' : 'neg'}">${formatted}</span>`;
	return item;
}

function formatMoney(value: number): string {
	const abs = Math.abs(value);
	const sign = value >= 0 ? '+' : '-';
	return `${sign}$${abs.toFixed(2)}`;
}

function formatPolicy(policy: KillSwitchPolicy): string {
	switch (policy) {
		case 'cancelOnly':
			return 'Cancel Only';
		case 'custom':
			return 'Custom';
		case 'flatten':
		default:
			return 'Flatten';
	}
}

function capitalize(text: string): string {
	return text.charAt(0).toUpperCase() + text.slice(1);
}

function emptyRow(message: string): HTMLElement {
	const empty = document.createElement('div');
	empty.className = 'empty-row';
	empty.textContent = message;
	return empty;
}

function promptModify(order: Order, state: ActiveSessionState, actions: ActiveSessionActions): void {
	const quantityText = window.prompt('New quantity (leave empty to keep):', String(order.quantity));
	if (quantityText === null) {
		return;
	}
	const priceText = window.prompt('New price (leave empty to keep):', order.price ? String(order.price) : '');
	if (priceText === null) {
		return;
	}

	const changes: { quantity?: number; price?: number } = {};
	const quantity = quantityText.trim() ? Number(quantityText) : undefined;
	const price = priceText.trim() ? Number(priceText) : undefined;

	if (quantity && !Number.isNaN(quantity)) {
		changes.quantity = quantity;
	}
	if (price && !Number.isNaN(price)) {
		changes.price = price;
	}

	if (!changes.quantity && !changes.price) {
		return;
	}

	actions.postMessage({
		type: 'modifyOrder',
		sessionId: state.session.id,
		orderId: order.id,
		changes
	});
}
