/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../../platform/quickinput/common/quickInput.js';
import { IQicStateService } from '../../common/state/qicStateService.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';

/**
 * Service status types
 */
export type ServiceStatus = 'ready' | 'degraded' | 'error' | 'initializing';

/**
 * Connection information
 */
export interface ConnectionInfo {
	provider: string;
	model?: string;
	latencyMs?: number;
	region?: string;
}

/**
 * Quick Pick item with optional action
 */
interface StatusQuickPickItem extends IQuickPickItem {
	action?: string;
}

/**
 * Status Quick Pick - shows detailed connection status and quick actions
 * Phase 3 - Prompt 03-08
 */
export class StatusQuickPick extends Disposable {
	constructor(
		private readonly quickInputService: IQuickInputService,
		private readonly stateService: IQicStateService,
		private readonly commandService: ICommandService,
		private readonly openerService: IOpenerService,
	) {
		super();
	}

	async show(): Promise<void> {
		const state = this.stateService.state;
		const serviceStatus = state.serviceStatus as ServiceStatus;
		const connection = state.connection;
		const degradationLevel = state.connection.degradationLevel ?? 0;

		const items: (StatusQuickPickItem | IQuickPickSeparator)[] = [];

		// Current status header
		items.push({
			label: this.getStatusLabel(serviceStatus, connection),
			description: this.getStatusDescription(serviceStatus),
			detail: this.getStatusDetail(connection),
			alwaysShow: true,
		});

		items.push({ type: 'separator', label: '' });

		// Connection details
		if (connection) {
			items.push({
				label: `$(cloud) Provider: ${connection.provider || 'Unknown'}`,
				description: connection.currentModel || '',
			});

			if (connection.latencyMs !== undefined) {
				items.push({
					label: `$(dashboard) Latency: ${connection.latencyMs}ms`,
					description: this.getLatencyRating(connection.latencyMs),
				});
			}

			if (degradationLevel > 0) {
				items.push({
					label: `$(warning) Degradation Level: ${degradationLevel}`,
					description: this.getDegradationDescription(degradationLevel),
				});
			}
		}

		items.push({ type: 'separator', label: localize('qic.status.actions', 'Actions') });

		// Quick actions
		items.push({
			label: '$(sync) Test connection',
			action: 'test-connection',
		});

		items.push({
			label: '$(arrow-swap) Switch provider',
			action: 'switch-provider',
		});

		items.push({
			label: '$(globe) View status page',
			action: 'status-page',
		});

		items.push({
			label: '$(gear) Open Orion settings',
			action: 'settings',
		});

		// Show Quick Pick
		const quickPick = this.quickInputService.createQuickPick<StatusQuickPickItem>();
		quickPick.items = items as any;
		quickPick.placeholder = localize('qic.status.placeholder', 'Orion Connection Status');
		quickPick.canSelectMany = false;

		quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			if (selected?.action) {
				this.executeAction(selected.action);
			}
			quickPick.hide();
		});

		quickPick.onDidHide(() => {
			quickPick.dispose();
		});

		quickPick.show();
	}

	private getStatusLabel(status: ServiceStatus, connection?: ConnectionInfo): string {
		const icon = this.getStatusIcon(status);
		const statusText = this.getStatusText(status);
		const provider = connection?.provider || 'Not connected';

		return `${icon} ${statusText} - ${provider}`;
	}

	private getStatusIcon(status: ServiceStatus): string {
		switch (status) {
			case 'ready': return '$(check)';
			case 'degraded': return '$(warning)';
			case 'error': return '$(error)';
			case 'initializing': return '$(loading~spin)';
			default: return '$(circle-outline)';
		}
	}

	private getStatusText(status: ServiceStatus): string {
		switch (status) {
			case 'ready': return localize('qic.status.connected', 'Connected');
			case 'degraded': return localize('qic.status.degraded', 'Degraded');
			case 'error': return localize('qic.status.error', 'Error');
			case 'initializing': return localize('qic.status.connecting', 'Connecting...');
			default: return localize('qic.status.unknown', 'Unknown');
		}
	}

	private getStatusDescription(status: ServiceStatus): string {
		switch (status) {
			case 'ready': return localize('qic.status.readyDesc', 'All systems operational');
			case 'degraded': return localize('qic.status.degradedDesc', 'Some features limited');
			case 'error': return localize('qic.status.errorDesc', 'Connection failed');
			case 'initializing': return localize('qic.status.initDesc', 'Please wait...');
			default: return '';
		}
	}

	private getStatusDetail(connection?: ConnectionInfo): string | undefined {
		if (!connection) return undefined;

		const parts: string[] = [];
		if (connection.latencyMs) {
			parts.push(`${connection.latencyMs}ms`);
		}
		if (connection.region) {
			parts.push(connection.region);
		}
		return parts.length > 0 ? parts.join(' · ') : undefined;
	}

	private getLatencyRating(ms: number): string {
		if (ms < 100) return localize('qic.latency.excellent', 'Excellent');
		if (ms < 300) return localize('qic.latency.good', 'Good');
		if (ms < 500) return localize('qic.latency.fair', 'Fair');
		return localize('qic.latency.slow', 'Slow');
	}

	private getDegradationDescription(level: number): string {
		switch (level) {
			case 1: return localize('qic.degradation.1', 'High latency detected');
			case 2: return localize('qic.degradation.2', 'Context reduced to 16K');
			case 3: return localize('qic.degradation.3', 'Limited features only');
			case 4: return localize('qic.degradation.4', 'Text-only mode');
			default: return '';
		}
	}

	private async executeAction(action: string): Promise<void> {
		switch (action) {
			case 'test-connection':
				await this.commandService.executeCommand('qic.testConnection');
				break;
			case 'switch-provider':
				await this.commandService.executeCommand('qic.switchProvider');
				break;
			case 'status-page':
				await this.openerService.open(URI.parse('https://status.quantlab.io'));
				break;
			case 'settings':
				await this.commandService.executeCommand('workbench.action.openSettings', 'qic');
				break;
		}
	}
}

/**
 * Factory function for showing status Quick Pick
 */
export function showStatusQuickPick(
	quickInputService: IQuickInputService,
	stateService: IQicStateService,
	commandService: ICommandService,
	openerService: IOpenerService,
): Promise<void> {
	const picker = new StatusQuickPick(
		quickInputService,
		stateService,
		commandService,
		openerService
	);
	return picker.show();
}
