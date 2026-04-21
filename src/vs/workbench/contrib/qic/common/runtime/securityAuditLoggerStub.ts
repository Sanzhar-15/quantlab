/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Audit entry for security logging.
 */
export interface AuditEntry {
	toolName: string;
	action: string;
	args?: Record<string, unknown>;
	sessionId: string;
	timestamp: string;
	outcome?: 'success' | 'denied' | 'error';
	reason?: string;
}

/**
 * Interface for the real SecurityAuditLogger (Prompt 14).
 */
export interface SecurityAuditLogger {
	logToolCall(entry: AuditEntry): void;
	logPermissionGrant(entry: AuditEntry): void;
	logEgressAttempt(entry: AuditEntry): void;
	flush(): Promise<void>;
}

/**
 * Test-only SecurityAuditLogger (Audit X-PS3, II-PG3).
 * Silent no-op implementation for use in tests. Replaced by real
 * implementation in Prompt 14 (Security Hardening).
 */
export class TestSecurityAuditLogger implements SecurityAuditLogger {

	logToolCall(_entry: AuditEntry): void {}

	logPermissionGrant(_entry: AuditEntry): void {}

	logEgressAttempt(_entry: AuditEntry): void {}

	async flush(): Promise<void> {}
}

/** @deprecated Use TestSecurityAuditLogger instead */
export const SecurityAuditLoggerStub = TestSecurityAuditLogger;
