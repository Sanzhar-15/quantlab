/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ConsentStore } from './consentStore.js';
import type { OptimizedSecretScanner } from './secretScanner.js';
import type { SecurityAuditLogger } from './auditLogger.js';

export type EgressBoundary = 'llm' | 'embedding' | 'telemetry' | 'network' | 'web-fetch' | 'web-search' | 'quantlab-cloud';

/**
 * Egress boundary enforcement — the gatekeeper for ALL data leaving the system.
 * Replaces the Phase 0 stub in egressBlocker.ts.
 *
 * INV-T3: No data leaves without consent and secret redaction.
 */
export class EgressBoundaryEnforcer {
	constructor(
		private readonly consentStore: ConsentStore,
		private readonly secretScanner: OptimizedSecretScanner,
		private readonly auditLogger?: SecurityAuditLogger,
	) {}

	async checkAndSanitize(
		boundary: EgressBoundary,
		data: string,
		context: { sessionId: string; purpose: string },
	): Promise<{ allowed: boolean; sanitizedData?: string; reason?: string }> {
		// Step 1: Check consent
		const hasConsent = await this.consentStore.hasConsent(boundary);
		if (!hasConsent) {
			const reason = `No consent for ${boundary} boundary (session: ${context.sessionId}, purpose: ${context.purpose})`;
			this.auditLogger?.logEgressAttempt({
				toolName: boundary,
				action: 'egress_blocked',
				sessionId: context.sessionId,
				timestamp: new Date().toISOString(),
				outcome: 'blocked',
				reason,
			});
			return { allowed: false, reason };
		}

		// Step 2: Scan and redact secrets
		const scanResult = this.secretScanner.scan(data);

		this.auditLogger?.logEgressAttempt({
			toolName: boundary,
			action: 'egress_allowed',
			sessionId: context.sessionId,
			timestamp: new Date().toISOString(),
			outcome: scanResult.findings.length > 0 ? 'allowed_redacted' : 'allowed',
		});

		return {
			allowed: true,
			sanitizedData: scanResult.redactedText,
		};
	}
}
