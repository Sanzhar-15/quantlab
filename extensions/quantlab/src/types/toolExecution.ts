/*---------------------------------------------------------------------------------------------
 *  Tool execution types for server-side statistical computation
 *--------------------------------------------------------------------------------------------*/

import { DataSourceDescriptor, Timeframe } from './market';

// ── Client-side request types ────────────────────────────────────────────────

export interface ToolExecutionRequest {
	toolId: string;
	dataSource: DataSourceDescriptor;
	columns: string[];
	parameters: Record<string, unknown>;
	timeframe?: Timeframe;
}

export interface ToolExecutionJob {
	jobId: string;
	status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
	progress?: number;
	message?: string;
	result?: ToolExecutionResult;
	error?: string;
}

export interface ToolExecutionResult {
	testId: string;
	testName: string;
	statistic: number;
	pValue: number | null;
	criticalValues?: Record<string, number>;
	conclusion: string;
	interpretation: string;
	details: Record<string, unknown>;
	visualizations?: Array<{ type: string; title: string; data: unknown }>;
}

// ── Wire format types (server snake_case) ────────────────────────────────────

export interface ServerToolExecutePayload {
	tool_id: string;
	data_source: ServerDataSourcePayload;
	columns: string[];
	parameters: Record<string, unknown>;
}

export type ServerDataSourcePayload =
	| { kind: 'server'; symbol: string; timeframe: string }
	| { kind: 'inline'; format: string; data: string; filename: string };

export interface ServerToolExecuteResponse {
	job_id: string;
	status: string;
	result?: ServerToolResult;
}

export interface ServerToolResult {
	test_id: string;
	test_name: string;
	statistic: number;
	p_value: number | null;
	critical_values?: Record<string, number>;
	conclusion: string;
	interpretation: string;
	details: Record<string, unknown>;
	visualizations?: Array<{ type: string; title: string; data: unknown }>;
}

export interface ToolJobStatusResponse {
	job_id: string;
	status: 'queued' | 'running' | 'complete' | 'failed' | 'cancelled';
	progress?: number;
	message?: string;
}
