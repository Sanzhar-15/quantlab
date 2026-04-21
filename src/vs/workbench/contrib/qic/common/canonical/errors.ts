/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface QicErrorTemplate {
	code: string;
	name: string;
	severity: 'info' | 'warning' | 'error';
	userMessage: string | null;
}

export const ERROR_REGISTRY: Record<string, QicErrorTemplate> = {
	// Tool errors
	'QIC-T001': { code: 'QIC-T001', name: 'ToolNotFound', severity: 'error', userMessage: 'The requested action is not available.' },
	'QIC-T002': { code: 'QIC-T002', name: 'ToolExecutionFailed', severity: 'error', userMessage: 'The action failed to complete.' },
	'QIC-T003': { code: 'QIC-T003', name: 'ToolTimeout', severity: 'error', userMessage: 'The action timed out.' },
	'QIC-T004': { code: 'QIC-T004', name: 'ToolPermissionDenied', severity: 'warning', userMessage: 'Permission denied for this action.' },
	'QIC-T005': { code: 'QIC-T005', name: 'ToolValidationFailed', severity: 'error', userMessage: 'Invalid parameters for the requested action.' },

	// Provider errors
	'QIC-P001': { code: 'QIC-P001', name: 'PathOutsideWorkspace', severity: 'error', userMessage: 'Path is outside the workspace.' },
	'QIC-P002': { code: 'QIC-P002', name: 'SymlinkOutsideWorkspace', severity: 'error', userMessage: 'Symlink target is outside the workspace.' },
	'QIC-P003': { code: 'QIC-P003', name: 'FileBlockedForSecurity', severity: 'warning', userMessage: 'File blocked for security reasons.' },
	'QIC-P004': { code: 'QIC-P004', name: 'ProviderUnavailable', severity: 'error', userMessage: 'AI provider is unavailable. Check your configuration.' },
	'QIC-P005': { code: 'QIC-P005', name: 'ProviderRateLimited', severity: 'warning', userMessage: 'Rate limit reached. Please wait before trying again.' },
	'QIC-P006': { code: 'QIC-P006', name: 'ProviderAuthFailed', severity: 'error', userMessage: 'Authentication failed. Check your API key.' },

	// Network errors
	'QIC-N001': { code: 'QIC-N001', name: 'SSRFBlocked', severity: 'error', userMessage: 'Request blocked: target address is not allowed.' },
	'QIC-N002': { code: 'QIC-N002', name: 'SSRFDnsRebind', severity: 'error', userMessage: 'Request blocked: DNS resolves to private address.' },
	'QIC-N003': { code: 'QIC-N003', name: 'RequestShed', severity: 'warning', userMessage: 'Request dropped due to capacity limits.' },
	'QIC-N004': { code: 'QIC-N004', name: 'EgressBlocked', severity: 'warning', userMessage: 'Network request blocked by egress policy.' },

	// Journal/crash-safe errors
	'QIC-J001': { code: 'QIC-J001', name: 'JournalCorrupt', severity: 'error', userMessage: 'Recovery journal is corrupted. It has been quarantined.' },
	'QIC-J002': { code: 'QIC-J002', name: 'JournalChecksumMismatch', severity: 'error', userMessage: 'Data integrity check failed.' },
	'QIC-J003': { code: 'QIC-J003', name: 'RollForwardFailed', severity: 'error', userMessage: 'Could not complete interrupted operation.' },
	'QIC-J004': { code: 'QIC-J004', name: 'RollBackFailed', severity: 'error', userMessage: 'Could not undo interrupted operation.' },

	// Storage errors
	'QIC-S001': { code: 'QIC-S001', name: 'DatabaseNotInitialized', severity: 'error', userMessage: 'QIC storage is not ready.' },
	'QIC-S002': { code: 'QIC-S002', name: 'DatabaseCorrupt', severity: 'error', userMessage: 'QIC storage is corrupted. Please restart.' },

	// Context errors
	'QIC-C001': { code: 'QIC-C001', name: 'IndexingFailed', severity: 'warning', userMessage: 'File indexing encountered an error.' },
	'QIC-C002': { code: 'QIC-C002', name: 'EmbeddingUnavailable', severity: 'warning', userMessage: 'Code search is limited (embedding unavailable).' },
	'QIC-C003': { code: 'QIC-C003', name: 'VectorIndexNotReady', severity: 'warning', userMessage: 'Vector index is not yet initialized.' },

	// Gateway errors
	'QIC-G001': { code: 'QIC-G001', name: 'CircuitBreakerOpen', severity: 'warning', userMessage: 'AI provider temporarily unavailable.' },
	'QIC-G002': { code: 'QIC-G002', name: 'AllProvidersDown', severity: 'error', userMessage: 'All AI providers are unavailable.' },

	// Security errors
	'QIC-X001': { code: 'QIC-X001', name: 'ConsentRequired', severity: 'info', userMessage: 'Your consent is required to proceed.' },
	'QIC-X002': { code: 'QIC-X002', name: 'SecretDetected', severity: 'warning', userMessage: 'Sensitive data was detected and redacted.' },
	'QIC-X003': { code: 'QIC-X003', name: 'AuditWriteFailed', severity: 'error', userMessage: null },
	'QIC-X004': { code: 'QIC-X004', name: 'CommandBlocked', severity: 'error', userMessage: 'This command was blocked for security.' },

	// Quant-specific errors
	'QIC-Q001': { code: 'QIC-Q001', name: 'PythonEnvNotFound', severity: 'error', userMessage: 'No suitable Python environment found.' },
	'QIC-Q002': { code: 'QIC-Q002', name: 'EngineDaemonNotRunning', severity: 'error', userMessage: 'Engine daemon not running. Start a trading session or enable auto-start.' },
	'QIC-Q003': { code: 'QIC-Q003', name: 'IpcTimeout', severity: 'error', userMessage: 'Communication with the engine daemon timed out.' },
	'QIC-Q004': { code: 'QIC-Q004', name: 'DataFrameLoadFailed', severity: 'warning', userMessage: 'Could not load DataFrame.' },

	// Cloud protocol errors
	'QIC-P007': { code: 'QIC-P007', name: 'FeatureRequiresPro', severity: 'warning', userMessage: 'This feature requires a Pro plan.' },
	'QIC-P008': { code: 'QIC-P008', name: 'IdempotencyConflict', severity: 'warning', userMessage: 'Duplicate request detected.' },
	'QIC-QUOTA': { code: 'QIC-QUOTA', name: 'QuotaExceeded', severity: 'error', userMessage: 'Your usage quota is exhausted.' },
	'QIC-UPGRADE': { code: 'QIC-UPGRADE', name: 'UpgradeRequired', severity: 'error', userMessage: 'Please update Quantlab to continue.' },

	// General errors
	'QIC-Y001': { code: 'QIC-Y001', name: 'InternalError', severity: 'error', userMessage: 'An unexpected error occurred.' },
	'QIC-Y002': { code: 'QIC-Y002', name: 'Cancelled', severity: 'info', userMessage: 'Request was cancelled.' },
	'QIC-Y003': { code: 'QIC-Y003', name: 'InvalidState', severity: 'error', userMessage: 'QIC is in an unexpected state. Please restart.' },
};

