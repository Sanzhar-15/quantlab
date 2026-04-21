/*---------------------------------------------------------------------------------------------
 *  Trust Module Exports.
 *
 *  Workspace and strategy trust management for live trading safety.
 *
 *  Spec Reference: Technical Spec §12.3 (Safety Layer)
 *--------------------------------------------------------------------------------------------*/

export { TrustManager, registerTrustCommands } from './TrustManager';
export type {
	TrustLevel,
	WorkspaceTrust,
	StrategyTrust,
	TrustVerificationResult,
	TrustPromptOptions,
	TrustPromptResult,
	TrustStoreEntry,
	TrustChangeEvent,
	TrustManagerEvents,
} from './types';
