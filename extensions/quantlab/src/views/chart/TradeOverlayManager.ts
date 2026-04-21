/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SessionManager } from '../../core/trading/SessionManager';
import { Fill } from '../../types/trading';
import { ChartOutboundMessage } from '../../types/chart';

interface OverlayBinding {
	sessionId: string;
	postMessage: (message: ChartOutboundMessage) => void;
}

export class TradeOverlayManager {
	private readonly sessionManager = SessionManager.getInstance();
	private readonly bindings = new Map<string, OverlayBinding>();
	private readonly fillsBySession = new Map<string, Fill[]>();

	constructor() {
		this.sessionManager.onPositionsUpdate(update => {
			this.broadcast(update.sessionId, { type: 'setTradePositions', sessionId: update.sessionId, positions: update.positions });
		});
		this.sessionManager.onOrdersUpdate(update => {
			this.broadcast(update.sessionId, { type: 'setTradeOrders', sessionId: update.sessionId, orders: update.orders });
		});
		this.sessionManager.onFill(update => {
			const fills = this.appendFill(update.sessionId, update.fill);
			this.broadcast(update.sessionId, { type: 'setTradeFills', sessionId: update.sessionId, fills });
		});
		this.sessionManager.onSessionStopped(event => {
			this.detachBySession(event.sessionId);
		});
	}

	attach(key: string, sessionId: string, postMessage: (message: ChartOutboundMessage) => void): void {
		this.bindings.set(key, { sessionId, postMessage });
		this.sendSnapshot(sessionId, postMessage);
	}

	detach(key: string): void {
		const binding = this.bindings.get(key);
		if (!binding) {
			return;
		}
		binding.postMessage({ type: 'clearTradeOverlays', sessionId: binding.sessionId });
		this.bindings.delete(key);
	}

	private detachBySession(sessionId: string): void {
		for (const [key, binding] of this.bindings.entries()) {
			if (binding.sessionId === sessionId) {
				binding.postMessage({ type: 'clearTradeOverlays', sessionId });
				this.bindings.delete(key);
			}
		}
	}

	private sendSnapshot(sessionId: string, postMessage: (message: ChartOutboundMessage) => void): void {
		const snapshot = this.sessionManager.getSessionSnapshot(sessionId);
		if (!snapshot) {
			return;
		}

		postMessage({ type: 'setTradePositions', sessionId, positions: snapshot.positions });
		postMessage({ type: 'setTradeOrders', sessionId, orders: snapshot.orders });
		const fills = this.fillsBySession.get(sessionId) ?? [];
		if (fills.length) {
			postMessage({ type: 'setTradeFills', sessionId, fills });
		}
	}

	private broadcast(sessionId: string, message: ChartOutboundMessage): void {
		for (const binding of this.bindings.values()) {
			if (binding.sessionId !== sessionId) {
				continue;
			}
			binding.postMessage(message);
		}
	}

	private appendFill(sessionId: string, fill: Fill): Fill[] {
		const existing = this.fillsBySession.get(sessionId) ?? [];
		const next = [fill, ...existing].slice(0, 120);
		this.fillsBySession.set(sessionId, next);
		return next;
	}
}
