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
export const QIC_SET_API_KEY_COMMAND_ID = 'qic.setApiKey';
export const QIC_SIGN_IN_COMMAND_ID = 'qic.signIn';
export const QIC_SIGN_OUT_COMMAND_ID = 'qic.signOut';
export const QIC_ACCOUNT_INFO_COMMAND_ID = 'qic.accountInfo';
export const QIC_SWITCH_MODE_COMMAND_ID = 'qic.switchConnectionMode';

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
	PROVIDER_DEFAULT: 'qic.provider.default',
	PROVIDER_OLLAMA_URL: 'qic.provider.ollamaUrl',
	COMPLETION_ENABLED: 'qic.completion.enabled',
	COMPLETION_DEBOUNCE_MS: 'qic.completion.debounceMs',
	PYTHON_PATH: 'qic.pythonPath',
	TELEMETRY_ENABLED: 'qic.telemetry.enabled',
	CONNECTION_MODE: 'qic.connectionMode',
	CLOUD_BASE_URL: 'qic.cloud.baseUrl',
	CLOUD_DEV_MODE: 'qic.cloud.devMode',
	DATA_TIER: 'qic.dataTier',
	LANE_OVERRIDES: 'qic.laneOverrides',
	CLOUD_ENABLED: 'qic.cloud.enabled',
	RESPONSE_STYLE: 'qic.responseStyle', // BYOK Optimization: concise | balanced | detailed
	SERVER_BASE_URL: 'qic.server.baseUrl',
} as const;

// Response style type (controls verbosity of LLM responses)
export type ResponseStyle = 'concise' | 'balanced' | 'detailed';

// Connection mode type
export type ConnectionMode = 'cloud' | 'byok' | 'local' | 'server';

// Data tier type (controls what telemetry data is shared)
export type DataTier = 'private' | 'anonymous-metrics' | 'data-contributor';

// SecretStorage keys (AUDIT FIX XI-SV7)
export const QIC_SECRET_KEYS = {
	ANTHROPIC_API_KEY: 'qic.anthropicApiKey',
	OPENAI_API_KEY: 'qic.openaiApiKey',
	CLOUD_ACCESS_TOKEN: 'qic.cloudAccessToken',
	CLOUD_REFRESH_TOKEN: 'qic.cloudRefreshToken',
	CLOUD_TOKEN_EXPIRES_AT: 'qic.cloudTokenExpiresAt',
	DELTAPLUS_ACCESS_TOKEN: 'qic.deltaplusAccessToken',
	DELTAPLUS_REFRESH_TOKEN: 'qic.deltaplusRefreshToken',
	DELTAPLUS_TOKEN_EXPIRES_AT: 'qic.deltaplusTokenExpiresAt',
} as const;

// OAuth2 auth constants for Quantlab Cloud
export const QIC_AUTH = {
	CLIENT_ID: 'qic-vscode',
	REDIRECT_URI: 'vscode://quantlab.qic/auth/callback',
	SCOPES: ['openid', 'profile', 'email', 'offline_access'],
	AUDIENCE: 'https://api.quantlab.dev',
} as const;

// Workspace storage subdirectories (AUDIT FIX VIII-PC5)
export const QIC_STORAGE_DIRS = [
	'checkpoints',
	'checkpoints/quarantine',
	'logs',
	'recordings',
	'security-audit',
] as const;
