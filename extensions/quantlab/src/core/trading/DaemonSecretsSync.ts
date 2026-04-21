/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Daemon Secrets Sync (FIX-CGP-008).
 *
 * Syncs broker credentials from VS Code SecretStorage to the Python daemon
 * via authenticated IPC. Credentials travel over the Unix socket (local only,
 * no network), and are never written to disk on the daemon side.
 */

import * as vscode from 'vscode';
import { DaemonClient } from './DaemonClient';

/**
 * Result of a credential sync operation.
 */
export interface CredentialSyncResult {
	success: boolean;
	broker: string;
	error?: string;
}

/**
 * Syncs broker credentials from extension SecretStorage to daemon via IPC.
 */
export class DaemonSecretsSync {
	constructor(
		private readonly secretStorage: vscode.SecretStorage,
	) {}

	/**
	 * Send stored credentials to daemon for a specific broker.
	 * Must be called after IPC auth handshake is complete.
	 */
	async syncCredentials(client: DaemonClient, broker: string): Promise<CredentialSyncResult> {
		const keyPrefix = `quantlab.broker.${broker}`;

		const apiKey = await this.secretStorage.get(`${keyPrefix}.apiKey`);
		const apiSecret = await this.secretStorage.get(`${keyPrefix}.apiSecret`);

		if (!apiKey || !apiSecret) {
			return {
				success: false,
				broker,
				error: 'Credentials not found in SecretStorage',
			};
		}

		try {
			const result = await client.setCredentials(broker, {
				api_key: apiKey,
				secret_key: apiSecret,
			});
			return { success: result.success, broker };
		} catch (error) {
			return {
				success: false,
				broker,
				error: (error as Error).message,
			};
		}
	}

	/**
	 * Check if daemon has credentials for a broker.
	 */
	async checkDaemonCredentials(client: DaemonClient, _broker: string): Promise<boolean> {
		try {
			const status = await client.getCredentialsStatus();
			const brokers = status?.brokers ?? {};
			return Object.values(brokers).some(b => b.configured);
		} catch {
			return false;
		}
	}

	/**
	 * Check if credentials exist in local SecretStorage.
	 */
	async hasLocalCredentials(broker: string): Promise<boolean> {
		const keyPrefix = `quantlab.broker.${broker}`;
		const apiKey = await this.secretStorage.get(`${keyPrefix}.apiKey`);
		return !!apiKey;
	}
}
