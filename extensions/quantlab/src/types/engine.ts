/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ActionConfig, QuickActionType } from './action';
import { StatsVisualization } from './stats';

export interface JobRequest {
	jobId: string;
	action: QuickActionType | string;
	strategyPath: string;
	strategyHash: string;
	config: ActionConfig;
	createdAt: string;
}

export interface JobProgressEvent {
	type: 'progress';
	jobId: string;
	progress: number;
	message: string;
	eta?: string;
}

export interface JobLogEvent {
	type: 'log';
	jobId: string;
	timestamp: string;
	message: string;
	level?: 'info' | 'warn' | 'error';
}

export interface JobCompleteEvent {
	type: 'complete';
	jobId: string;
	result: JobResult;
}

export interface JobFailedEvent {
	type: 'failed';
	jobId: string;
	error: string;
	stack?: string;
}

export interface JobResult {
	metrics: Record<string, number>;
	warnings?: string[];
	artifactPath?: string;
	signals?: Array<{ t: number; type: 'entry' | 'exit'; label?: string; price?: number }>;
	equity?: Array<{ t: number; v: number }>;
}

export type EngineEvent = JobProgressEvent | JobLogEvent | JobCompleteEvent | JobFailedEvent | StatsCompleteEvent;

// Stats job request (different from strategy JobRequest)
export interface StatsJobRequest {
	jobId: string;
	action: 'stats';
	testId: string;
	dataPath: string;
	columns: string[];
	parameters: Record<string, unknown>;
	createdAt: string;
}

export interface StatsJobResult {
	testId: string;
	testName: string;
	statistic: number;
	pValue: number | null;
	criticalValues?: Record<string, number>;
	conclusion: string;
	interpretation: string;
	details: Record<string, unknown>;
	visualizations?: StatsVisualization[];
}

export interface StatsCompleteEvent {
	type: 'stats-complete';
	jobId: string;
	result: StatsJobResult;
}
