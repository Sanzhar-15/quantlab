/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { BrokerAdapter, OrderRequest } from '../../core/broker/BrokerAdapter';
import { SessionManager } from '../../core/trading/SessionManager';
import { KillSwitchAction, KillSwitchConfig, KillSwitchPolicy, SessionInfo } from '../../types/trading';

export class KillSwitch {
	private static instance: KillSwitch | undefined;

	static getInstance(): KillSwitch {
		if (!KillSwitch.instance) {
			KillSwitch.instance = new KillSwitch();
		}
		return KillSwitch.instance;
	}

	getConfig(): KillSwitchConfig {
		const config = vscode.workspace.getConfiguration('quantlab.trading');
		const policy = (config.get<string>('killSwitchPolicy') ?? 'flatten') as KillSwitchPolicy;
		const customActions = config.get<KillSwitchAction[]>('killSwitchCustomActions');
		return { policy, customActions };
	}

	getPolicyLabel(config?: KillSwitchConfig): string {
		const policy = config?.policy ?? this.getConfig().policy;
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

	async execute(session: SessionInfo, broker: BrokerAdapter, config: KillSwitchConfig, output: vscode.OutputChannel): Promise<void> {
		const actions = this.resolveActions(config);
		output.appendLine(`[${session.id}] Kill Switch: ${config.policy}`);

		// CODEX-007: Route through daemon for daemon-managed sessions.
		// Daemon has circuit breaker, exposure manager, and reconciliation
		// that should process the kill switch for safety.
		const sessionManager = SessionManager.getInstance();
		const useDaemon = sessionManager.isUsingDaemon(session.id);
		const daemonClient = useDaemon ? sessionManager.getDaemonClient(session.id) : undefined;

		for (const action of actions) {
			switch (action.type) {
				case 'cancelOrders':
					if (daemonClient) {
						try {
							output.appendLine(`[${session.id}] Cancelling orders via daemon...`);
							const orders = await daemonClient.getOrders();
							for (const order of orders) {
								await daemonClient.cancelOrder(order.orderId);
								output.appendLine(`Cancelled order ${order.orderId} (via daemon)`);
							}
						} catch (error) {
							output.appendLine(`Daemon cancel failed, falling back to broker: ${(error as Error).message}`);
							await this.cancelOrders(broker, output);
						}
					} else {
						await this.cancelOrders(broker, output);
					}
					break;
				case 'flattenPositions':
					if (daemonClient) {
						try {
							output.appendLine(`[${session.id}] Flattening positions via daemon...`);
							await daemonClient.flattenPositions();
							output.appendLine(`Positions flattened (via daemon)`);
						} catch (error) {
							output.appendLine(`Daemon flatten failed, falling back to broker: ${(error as Error).message}`);
							await this.flattenPositions(broker, output);
						}
					} else {
						await this.flattenPositions(broker, output);
					}
					break;
				case 'pauseStrategy':
					if (daemonClient) {
						try {
							await daemonClient.pauseSession();
							output.appendLine(`[${session.id}] Strategy paused (via daemon)`);
						} catch {
							output.appendLine(`[${session.id}] Pause strategy requested.`);
						}
					} else {
						output.appendLine(`[${session.id}] Pause strategy requested.`);
					}
					break;
				default:
					output.appendLine(`[${session.id}] Custom kill switch action skipped.`);
					break;
			}
		}
	}

	private resolveActions(config: KillSwitchConfig): KillSwitchAction[] {
		switch (config.policy) {
			case 'cancelOnly':
				return [{ type: 'cancelOrders' }];
			case 'custom':
				return Array.isArray(config.customActions) && config.customActions.length
					? config.customActions
					: [{ type: 'cancelOrders' }];
			case 'flatten':
			default:
				return [{ type: 'cancelOrders' }, { type: 'flattenPositions' }];
		}
	}

	private async cancelOrders(broker: BrokerAdapter, output: vscode.OutputChannel): Promise<void> {
		const orders = await broker.getOpenOrders();
		const errors: string[] = [];
		for (const order of orders) {
			try {
				await broker.cancelOrder(order.id);
				output.appendLine(`Cancelled order ${order.id}`);
			} catch (error) {
				output.appendLine(`FAILED to cancel order ${order.id}: ${(error as Error).message}`);
				errors.push(order.id);
			}
		}
		if (errors.length > 0) {
			throw new Error(`Kill switch: failed to cancel ${errors.length} order(s): ${errors.join(', ')}`);
		}
	}

	private async flattenPositions(broker: BrokerAdapter, output: vscode.OutputChannel): Promise<void> {
		const positions = await broker.getPositions();
		const errors: string[] = [];
		for (const position of positions) {
			if (!position.quantity) {
				continue;
			}

			const request: OrderRequest = {
				symbol: position.symbol,
				side: position.quantity > 0 ? 'sell' : 'buy',
				type: 'market',
				quantity: Math.abs(position.quantity),
				timeInForce: 'day'
			};

			try {
				await broker.placeOrder(request);
				output.appendLine(`Flattened ${position.symbol} (${position.quantity})`);
			} catch (error) {
				output.appendLine(`FAILED to flatten ${position.symbol}: ${(error as Error).message}`);
				errors.push(position.symbol);
			}
		}
		if (errors.length > 0) {
			throw new Error(`Kill switch: failed to flatten ${errors.length} position(s): ${errors.join(', ')}`);
		}
	}
}
