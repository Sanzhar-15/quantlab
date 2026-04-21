/*---------------------------------------------------------------------------------------------
 *  Trust System Types.
 *
 *  Defines types for workspace and strategy trust management.
 *
 *  Spec Reference: Technical Spec §12.3 (Safety Layer)
 *--------------------------------------------------------------------------------------------*/

/**
 * Trust levels for strategies and workspaces.
 */
export type TrustLevel = 'untrusted' | 'trusted' | 'verified';

/**
 * Workspace trust state.
 */
export interface WorkspaceTrust {
	workspaceUri: string;
	trusted: boolean;
	trustedAt?: number;
	trustedBy?: string;
	hash?: string;
}

/**
 * Strategy trust state.
 */
export interface StrategyTrust {
	strategyPath: string;
	workspaceUri: string;
	trustLevel: TrustLevel;
	trustedAt?: number;
	hash: string;
	lastVerifiedAt?: number;
	lastVerifiedHash?: string;
}

/**
 * Trust verification result.
 */
export interface TrustVerificationResult {
	isValid: boolean;
	reason?: string;
	hashMismatch?: boolean;
	workspaceUntrusted?: boolean;
}

/**
 * Trust prompt options.
 */
export interface TrustPromptOptions {
	strategyPath: string;
	workspaceUri: string;
	showDetails?: boolean;
	allowRemember?: boolean;
}

/**
 * Trust prompt result.
 */
export interface TrustPromptResult {
	trusted: boolean;
	remember: boolean;
	cancelled: boolean;
}

/**
 * Trust store entry.
 */
export interface TrustStoreEntry {
	type: 'workspace' | 'strategy';
	uri: string;
	trustLevel: TrustLevel;
	hash?: string;
	trustedAt: number;
	expiresAt?: number;
}

/**
 * Trust change event.
 */
export interface TrustChangeEvent {
	type: 'workspace' | 'strategy';
	uri: string;
	previousTrust: TrustLevel;
	newTrust: TrustLevel;
	timestamp: number;
}

/**
 * Trust manager events.
 */
export interface TrustManagerEvents {
	'trust.changed': (event: TrustChangeEvent) => void;
	'trust.revoked': (uri: string) => void;
	'trust.expired': (uri: string) => void;
	[key: string]: (...args: any[]) => void;
}
