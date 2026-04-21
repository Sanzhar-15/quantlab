/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { TradeOutboundMessage } from '../../src/types/tradeMessages';
import type {
	ActivityEntry,
	KillSwitchPolicy,
	Order,
	PerformanceMetrics,
	Position,
	RequirementsCheck,
	RiskAlert,
	SessionInfo,
	TradeErrorState
} from '../../src/types/trading';
import { renderNoSession } from './states/noSession';
import { renderActiveSession } from './states/activeSession';
import { applyReducedMotion, applyTheme, ReducedMotionMode, ThemePayload } from '../shared/appearance';

declare function acquireVsCodeApi(): { postMessage: (message: unknown) => void };

const vscode = acquireVsCodeApi();
const root = document.getElementById('trade-root');

if (!root) {
	throw new Error('Trade root not found');
}

const container = document.createElement('div');
container.className = 'trade-shell';
root.appendChild(container);

applyReducedMotion('auto');

type RequirementsPolicy = { requireBacktest: boolean; requirePaperTrading: boolean; requireRiskReview: boolean };

interface TradeViewState {
	session: SessionInfo | null;
	requirements: RequirementsCheck;
	requirementsPolicy: RequirementsPolicy;
	killSwitchPolicy: KillSwitchPolicy;
	positions: Position[];
	orders: Order[];
	performance: PerformanceMetrics | null;
	activity: ActivityEntry[];
	heartbeat: { status: 'ok' | 'stale' | 'lost'; lastSeen: number } | null;
	riskAlerts: RiskAlert[];
	errorState: TradeErrorState | null;
}

const defaultRequirements: RequirementsCheck = {
	validStrategy: false,
	complexity: 'viewOnly',
	brokerConfigured: false,
	hasBacktest: false,
	hasPaperTrading: false,
	riskReviewed: false
};

let state: TradeViewState = {
	session: null,
	requirements: defaultRequirements,
	requirementsPolicy: { requireBacktest: false, requirePaperTrading: false, requireRiskReview: false },
	killSwitchPolicy: 'flatten',
	positions: [],
	orders: [],
	performance: null,
	activity: [],
	heartbeat: null,
	riskAlerts: [],
	errorState: null
};

const postMessage = (message: unknown) => vscode.postMessage(message);
let renderScheduled = false;
const lastSeqBySession = new Map<string, number>();

function scheduleRender(): void {
	if (renderScheduled) {
		return;
	}
	renderScheduled = true;
	requestAnimationFrame(() => {
		renderScheduled = false;
		render();
	});
}

function render(): void {
	container.replaceChildren();
	if (!state.session) {
		renderNoSession(container, state, { postMessage });
		return;
	}
	renderActiveSession(container, state, { postMessage });
}

function handleMessage(message: unknown): void {
	const data = message as TradeOutboundMessage;
	if (!data || typeof data !== 'object' || !('type' in data)) {
		return;
	}

	if (!shouldApplyMessage(data)) {
		return;
	}

	switch (data.type) {
		case 'init': {
			state = {
				...state,
				session: data.session ?? null,
				requirements: data.requirements ?? defaultRequirements,
				requirementsPolicy: data.requirementsPolicy ?? state.requirementsPolicy,
				killSwitchPolicy: data.killSwitchPolicy ?? state.killSwitchPolicy
			};
			if (typeof data.scrollPosition === 'number') {
				container.scrollTop = data.scrollPosition;
			}
			scheduleRender();
			return;
		}
		case 'requirementsUpdate':
			state = {
				...state,
				requirements: data.requirements,
				requirementsPolicy: data.requirementsPolicy ?? state.requirementsPolicy
			};
			scheduleRender();
			return;
		case 'sessionStarted':
			state = {
				...state,
				session: data.session,
				positions: [],
				orders: [],
				activity: [],
				riskAlerts: [],
				errorState: null
			};
			lastSeqBySession.delete(data.session.id);
			scheduleRender();
			return;
		case 'sessionUpdated':
			state = { ...state, session: data.session };
			scheduleRender();
			return;
		case 'sessionStopped':
			state = {
				...state,
				session: null,
				positions: [],
				orders: [],
				activity: [],
				riskAlerts: [],
				errorState: null,
				performance: null,
				heartbeat: null
			};
			lastSeqBySession.delete(data.sessionId);
			scheduleRender();
			return;
		case 'positionsUpdate':
			state = { ...state, positions: data.positions };
			scheduleRender();
			return;
		case 'ordersUpdate':
			state = { ...state, orders: data.orders };
			scheduleRender();
			return;
		case 'performanceUpdate':
			state = { ...state, performance: data.performance };
			scheduleRender();
			return;
		case 'activity':
			state = { ...state, activity: [data.entry, ...state.activity].slice(0, 120) };
			scheduleRender();
			return;
		case 'heartbeat':
			state = { ...state, heartbeat: { status: data.status, lastSeen: data.lastSeen } };
			scheduleRender();
			return;
		case 'riskAlert':
			state = { ...state, riskAlerts: [data.alert, ...state.riskAlerts].slice(0, 5) };
			scheduleRender();
			return;
		case 'errorState':
			state = { ...state, errorState: data.error };
			scheduleRender();
			return;
		default:
			return;
	}
}

function shouldApplyMessage(data: TradeOutboundMessage): boolean {
	if (data.type === 'positionsUpdate' ||
		data.type === 'ordersUpdate' ||
		data.type === 'performanceUpdate' ||
		data.type === 'activity' ||
		data.type === 'fill' ||
		data.type === 'heartbeat' ||
		data.type === 'riskAlert' ||
		data.type === 'errorState') {
		if (!state.session || data.sessionId !== state.session.id) {
			return false;
		}
	}

	if (!('seq' in data) || typeof data.seq !== 'number') {
		return true;
	}
	if (!('sessionId' in data) || typeof data.sessionId !== 'string') {
		return true;
	}
	const lastSeq = lastSeqBySession.get(data.sessionId) ?? -1;
	if (data.seq <= lastSeq) {
		return false;
	}
	lastSeqBySession.set(data.sessionId, data.seq);
	return true;
}

let scrollTimer: number | undefined;
container.addEventListener('scroll', () => {
	if (scrollTimer) {
		window.clearTimeout(scrollTimer);
	}
	scrollTimer = window.setTimeout(() => {
		postMessage({ type: 'scrollPosition', value: container.scrollTop });
		scrollTimer = undefined;
	}, 250);
});

window.addEventListener('message', event => {
	const data = event.data as { type?: string; theme?: ThemePayload; mode?: ReducedMotionMode };
	if (data?.type === 'theme') {
		applyTheme(data.theme);
		return;
	}
	if (data?.type === 'reducedMotion') {
		applyReducedMotion(data.mode ?? 'auto');
		return;
	}
	handleMessage(event.data);
});

postMessage({ type: 'ready' });
