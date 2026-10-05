/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ConsentRecord, ConsentStore } from './consent';

/** The part of `vscode.Memento` the consent store uses (`ExtensionContext.workspaceState`). */
export interface StateMemento {
	get<T>(key: string): T | undefined;
	update(key: string, value: unknown): PromiseLike<void>;
}

export const KERNEL_CONSENT_KEY = 'quantlab.quantbook.kernel.consent';

/**
 * The consent record of the open workspace, kept in its workspace state (QL-KERNEL, row CK-2).
 * Workspace state is already per workspace, so one record is stored; `get` returns it as stored and
 * `assertStrategyMayLeave` refuses a record that names another workspace.
 */
export function workspaceConsentStore(state: StateMemento): ConsentStore {
	return {
		get(_workspace: string): ConsentRecord | undefined {
			const stored = state.get<unknown>(KERNEL_CONSENT_KEY);
			if (stored === undefined) {
				return undefined;
			}
			const record = stored as Partial<ConsentRecord> | null;
			if (record === null || typeof record !== 'object' || typeof record.workspace !== 'string' || typeof record.grantedAt !== 'string') {
				throw new Error(`[kernel_consent_corrupt] the stored consent record is not { workspace, grantedAt }: ${JSON.stringify(stored)}`);
			}
			return { workspace: record.workspace, grantedAt: record.grantedAt };
		},
		async set(record: ConsentRecord): Promise<void> {
			await state.update(KERNEL_CONSENT_KEY, { workspace: record.workspace, grantedAt: record.grantedAt });
		},
		async clear(_workspace: string): Promise<void> {
			await state.update(KERNEL_CONSENT_KEY, undefined);
		},
	};
}
