/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConsentStore } from './consentStore.js';
import type { EgressBoundary } from './egressEnforcer.js';

export interface FirstRunResult {
	isFirstRun: boolean;
	consentsGranted: EgressBoundary[];
	consentsDeclined: EgressBoundary[];
	canProceed: boolean;
}

const REQUIRED_BOUNDARIES: EgressBoundary[] = ['llm'];
const ALL_BOUNDARIES: EgressBoundary[] = ['llm', 'embedding', 'telemetry', 'network', 'web-fetch', 'web-search'];

/**
 * Manages the first-run consent flow.
 * Called during activation before any AI features activate.
 */
export class FirstRunManager {
	constructor(
		private readonly consentStore: ConsentStore,
	) {}

	async checkAndPrompt(): Promise<FirstRunResult> {
		const isFirstRun = await this.consentStore.isFirstRun();

		if (!isFirstRun) {
			const consents = await this.consentStore.getAllConsents();
			const granted = consents.filter(c => c.granted).map(c => c.boundary);
			return {
				isFirstRun: false,
				consentsGranted: granted,
				consentsDeclined: ALL_BOUNDARIES.filter(b => !granted.includes(b)),
				canProceed: REQUIRED_BOUNDARIES.every(b => granted.includes(b)),
			};
		}

		// First run — do NOT auto-grant any boundaries.
		// The user must explicitly consent via the FirstRunView UI before
		// any AI features or network egress is enabled.
		return {
			isFirstRun: true,
			consentsGranted: [],
			consentsDeclined: ALL_BOUNDARIES,
			canProceed: false,
		};
	}
}
