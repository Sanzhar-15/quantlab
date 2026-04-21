/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type RunType = 'backtest' | 'wfa' | 'paper' | 'live' | 'optimize' | 'monteCarlo';

export type RunStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface HistoryEntry {
	id: string;
	type: RunType;
	status: RunStatus;
	strategyPath: string;
	strategyHash: string;
	startedAt: Date;
	completedAt?: Date;
	progress?: number;
	progressMessage?: string;
	passed?: boolean;
	metrics?: Record<string, number>;
	warnings?: string[];
	errorMessage?: string;
	artifactPath: string;
	pinned: boolean;
	tags: string[];
	viewedAt?: Date;
}

export interface HistoryQuery {
	type?: RunType;
	status?: RunStatus;
	strategyPath?: string;
	pinned?: boolean;
	limit?: number;
}

export interface HistoryArtifacts {
	signals?: Array<{ t: number; type: 'entry' | 'exit'; label?: string; price?: number }>;
	equity?: Array<{ t: number; v: number }>;
}
