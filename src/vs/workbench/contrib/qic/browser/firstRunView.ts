/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConsentStore } from '../common/security/consentStore.js';
import type { HostToWebviewMessage } from '../common/ui/messageProtocol.js';

export interface ConsentSelections {
	llm: boolean;
	embeddings: boolean;
	telemetry: boolean;
}

/**
 * First-run consent screen manager (Prompt 13).
 *
 * Shows the welcome screen on first activation. Minimum consent (llm=true)
 * is required before QIC features activate.
 */
export class FirstRunManager {

	constructor(
		private readonly consentStore: ConsentStore,
		_postMessage: (msg: HostToWebviewMessage) => void,
	) {}

	/**
	 * Check if first-run consent is needed and show the screen if so.
	 * Returns true if consent is already granted.
	 */
	async needsFirstRun(): Promise<boolean> {
		return !(await this.consentStore.hasConsent('llm'));
	}

	/**
	 * Process the consent selections from the first-run screen.
	 */
	async processConsent(selections: ConsentSelections): Promise<void> {
		if (selections.llm) {
			await this.consentStore.grantConsent('llm', 'global');
		}
		if (selections.embeddings) {
			await this.consentStore.grantConsent('embedding', 'global');
		}
		if (selections.telemetry) {
			await this.consentStore.grantConsent('telemetry', 'global');
		}
	}
}
