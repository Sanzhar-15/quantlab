/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { HistoryEntry } from './history';

export type ActionStateType = 'selection' | 'prompt' | 'configuration' | 'running' | 'results';

export type QuickActionType = 'backtest' | 'optimize' | 'monteCarlo' | 'wfa';

export interface StrategyInfo {
	path: string;
	isValid: boolean;
	validationMessage?: string;
}

export interface ConfigFieldOption {
	label: string;
	value: string;
}

export interface ConfigField {
	id: string;
	label: string;
	type: 'text' | 'number' | 'select' | 'checkbox' | 'date' | 'file';
	required?: boolean;
	min?: number;
	max?: number;
	step?: number;
	options?: ConfigFieldOption[];
	description?: string;
	fileFilter?: string[];
}

export interface ConfigSection {
	id: string;
	label: string;
	fields: ConfigField[];
}

export interface ConfigSchema {
	id: string;
	label: string;
	sections: ConfigSection[];
}

export interface ActionValidationResult {
	isValid: boolean;
	errors: Record<string, string>;
}

export interface ActionPromptState {
	type: 'prompt';
	fileType: 'strategy' | 'data';
	filePath: string;
}

export interface ResourceMeta {
	description: string;
	testExplanations?: Record<string, string>;
	resultHints?: string[];
}

export interface ActionSelectionState {
	type: 'selection';
	quickActions: QuickActionType[];
	recentRuns: HistoryEntry[];
	strategyPath: string;
	validation?: ActionValidationResult;
}

export interface ActionConfigurationState {
	type: 'configuration';
	action: QuickActionType | string;
	schema: ConfigSchema;
	values: Record<string, unknown>;
	validation: ActionValidationResult;
	resourceId?: string;
	resourceMeta?: ResourceMeta;
}

export interface ActionRunningState {
	type: 'running';
	jobId: string;
	action: string;
	startedAt: string;
	progress: number;
	message?: string;
	logs: ActionLogEntry[];
}

export interface StatsResult {
	testId: string;
	testName: string;
	statistic: number;
	pValue: number | null;
	criticalValues?: Record<string, number>;
	conclusion: string;
	interpretation: string;
	details?: Record<string, unknown>;
}

export interface ActionResultsState {
	type: 'results';
	runId: string;
	action: string;
	status: 'completed' | 'failed' | 'cancelled';
	metrics?: Record<string, number>;
	warnings?: string[];
	error?: string;
	artifactPath?: string;
	durationMs?: number;
	logs?: ActionLogEntry[];
	resourceId?: string;
	resourceMeta?: ResourceMeta;
	statsResult?: StatsResult;
}

export type ActionState =
	| ActionPromptState
	| ActionSelectionState
	| ActionConfigurationState
	| ActionRunningState
	| ActionResultsState;

export interface ActionLogEntry {
	timestamp: string;
	message: string;
	level?: 'info' | 'warn' | 'error';
}

export interface ActionConfig {
	action: QuickActionType | string;
	values: Record<string, unknown>;
}
