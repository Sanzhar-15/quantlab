/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// View container and view IDs
export const QIC_VIEW_CONTAINER_ID = 'workbench.view.qic';
export const QIC_CHAT_VIEW_ID = 'workbench.view.qic.chat';
export const QIC_TITLE = 'Orion';

// Command IDs
export const QIC_NEW_CHAT_COMMAND_ID = 'qic.newChat';
export const QIC_FOCUS_INPUT_COMMAND_ID = 'qic.focusInput';
export const QIC_CANCEL_COMMAND_ID = 'qic.cancel';
export const QIC_CREATE_CHECKPOINT_COMMAND_ID = 'qic.createCheckpoint';
export const QIC_RESTORE_CHECKPOINT_COMMAND_ID = 'qic.restoreCheckpoint';
export const QIC_SHOW_SETTINGS_COMMAND_ID = 'qic.showSettings';
export const QIC_TOGGLE_COMPLETION_COMMAND_ID = 'qic.toggleCompletion';
export const QIC_RETRY_CONNECTION_COMMAND_ID = 'qic.retryConnection';
export const QIC_SIGN_IN_COMMAND_ID = 'qic.signIn';
export const QIC_SIGN_OUT_COMMAND_ID = 'qic.signOut';
export const QIC_ACCOUNT_INFO_COMMAND_ID = 'qic.accountInfo';

// Context keys
export const QIC_PANEL_VISIBLE_CONTEXT = 'qicPanelVisible';
export const QIC_IS_PROCESSING_CONTEXT = 'qicIsProcessing';
export const QIC_STATE_CONTEXT = 'qicState';
export const QIC_CONNECTION_MODE_CONTEXT = 'qicConnectionMode';

// Storage keys
export const QIC_STATE_STORAGE_KEY = 'qic.state';

// Output channel
export const QIC_OUTPUT_CHANNEL_ID = 'Orion';

// Settings keys (AUDIT FIX XI-SV7: API keys use SecretStorage, NOT settings)
export const QIC_SETTINGS = {
	COMPLETION_ENABLED: 'qic.completion.enabled',
	COMPLETION_DEBOUNCE_MS: 'qic.completion.debounceMs',
	PYTHON_PATH: 'qic.pythonPath',
	TELEMETRY_ENABLED: 'qic.telemetry.enabled',
	CONNECTION_MODE: 'qic.connectionMode',
	DATA_TIER: 'qic.dataTier',
	LANE_OVERRIDES: 'qic.laneOverrides',
	RESPONSE_STYLE: 'qic.responseStyle', // BYOK Optimization: concise | balanced | detailed
} as const;

// Response style type (controls verbosity of LLM responses)
export type ResponseStyle = 'concise' | 'balanced' | 'detailed';

// Connection mode type: the Delta Plus Server through the host is the only mode (cloud, byok and local were retired)
export type ConnectionMode = 'server';

// Data tier type (controls what telemetry data is shared)
export type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';

// Workspace storage subdirectories (AUDIT FIX VIII-PC5)
export const QIC_STORAGE_DIRS = [
	'checkpoints',
	'checkpoints/quarantine',
	'logs',
	'recordings',
	'security-audit',
] as const;
