/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { SessionManager } from '../../core/trading/SessionManager';

const UPDATE_COALESCE_MS = 150;

export class BadgeManager {
	private tradeView: vscode.TreeView<unknown> | undefined;
	private tradeCount = -1;
	private pendingTradeUpdate: NodeJS.Timeout | undefined;
	private readonly subscriptions: vscode.Disposable[] = [];

	constructor(private readonly sessionManager: SessionManager) {
		this.subscriptions.push(
			this.sessionManager.onSessionsChanged(() => this.scheduleTradeUpdate()),
			this.sessionManager.onOrdersUpdate(() => this.scheduleTradeUpdate())
		);
	}

	registerTradeView(view: vscode.TreeView<unknown>): void {
		this.tradeView = view;
		this.scheduleTradeUpdate();
	}

	private scheduleTradeUpdate(): void {
		if (this.pendingTradeUpdate) {
			clearTimeout(this.pendingTradeUpdate);
		}

		this.pendingTradeUpdate = setTimeout(() => {
			this.pendingTradeUpdate = undefined;
			this.updateTradeBadge();
		}, UPDATE_COALESCE_MS);
	}

	private updateTradeBadge(): void {
		if (!this.tradeView) {
			return;
		}

		const count = this.sessionManager.getAllOpenOrders().length;
		if (count === this.tradeCount) {
			return;
		}

		this.tradeCount = count;
		this.tradeView.badge = count > 0 ? { value: count, tooltip: `${count} open orders` } : undefined;
	}

	dispose(): void {
		if (this.pendingTradeUpdate) {
			clearTimeout(this.pendingTradeUpdate);
			this.pendingTradeUpdate = undefined;
		}
		for (const sub of this.subscriptions) {
			sub.dispose();
		}
		this.subscriptions.length = 0;
	}
}
