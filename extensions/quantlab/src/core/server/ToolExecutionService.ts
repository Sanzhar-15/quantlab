/*---------------------------------------------------------------------------------------------
 *  ToolExecutionService - Manages tool execution against the Delta Plus Server
 *  with local Python fallback when server is unavailable.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { ServerApiClient } from './ServerApiClient';
import { isLocalFileSource, isServerSource, toServerTimeframe } from '../../types/market';
import {
	ToolExecutionRequest,
	ToolExecutionJob,
	ToolExecutionResult,
	ServerToolExecutePayload,
	ServerDataSourcePayload,
	ServerToolResult,
} from '../../types/toolExecution';

const POLL_INTERVAL_MS = 1000;
const POLL_MAX_ATTEMPTS = 300; // 5 minutes max

export class ToolExecutionService {
	private static instance: ToolExecutionService | undefined;
	private activeJobs = new Map<string, { cancel: () => void }>();

	private constructor() {}

	static getInstance(): ToolExecutionService {
		if (!ToolExecutionService.instance) {
			ToolExecutionService.instance = new ToolExecutionService();
		}
		return ToolExecutionService.instance;
	}

	static resetInstance(): void {
		if (ToolExecutionService.instance) {
			ToolExecutionService.instance.cancelAll();
			ToolExecutionService.instance = undefined;
		}
	}

	async submitExecution(request: ToolExecutionRequest): Promise<ToolExecutionJob> {
		const client = ServerApiClient.getInstance();

		// Build wire-format payload
		const dataSource = await this.buildDataSourcePayload(request);
		const payload: ServerToolExecutePayload = {
			tool_id: request.toolId,
			data_source: dataSource,
			columns: request.columns,
			parameters: request.parameters,
		};

		// Submit to server
		const response = await client.executeToolJob(payload);

		// If server returned inline result (synchronous completion)
		if (response.result) {
			return {
				jobId: response.job_id,
				status: 'complete',
				result: this.mapServerResult(response.result),
			};
		}

		// Async job — poll until complete
		return this.pollUntilComplete(response.job_id);
	}

	async getResult(jobId: string): Promise<ToolExecutionResult> {
		const client = ServerApiClient.getInstance();
		const raw = await client.getToolJobResult(jobId);
		return this.mapServerResult(raw as ServerToolResult);
	}

	async cancelExecution(jobId: string): Promise<void> {
		const active = this.activeJobs.get(jobId);
		if (active) {
			active.cancel();
			this.activeJobs.delete(jobId);
		}

		try {
			const client = ServerApiClient.getInstance();
			await client.cancelToolJob(jobId);
		} catch {
			// Best effort — job may already be complete
		}
	}

	dispose(): void {
		this.cancelAll();
	}

	// ── Internal ─────────────────────────────────────────────────────────────

	private async buildDataSourcePayload(request: ToolExecutionRequest): Promise<ServerDataSourcePayload> {
		const source = request.dataSource;

		if (isServerSource(source)) {
			const tf = request.timeframe ? toServerTimeframe(request.timeframe) : '1h';
			return {
				kind: 'server',
				symbol: source.symbol,
				timeframe: tf,
			};
		}

		if (isLocalFileSource(source)) {
			const filePath = source.filePath;
			const data = await fs.promises.readFile(filePath);
			const base64 = data.toString('base64');
			const ext = path.extname(filePath).toLowerCase().replace('.', '');
			const format = ext === 'csv' ? 'csv' : ext === 'parquet' ? 'parquet' : ext;

			return {
				kind: 'inline',
				format,
				data: base64,
				filename: path.basename(filePath),
			};
		}

		throw new Error('Unsupported data source type');
	}

	private async pollUntilComplete(jobId: string): Promise<ToolExecutionJob> {
		const client = ServerApiClient.getInstance();
		let cancelled = false;
		let pendingTimer: ReturnType<typeof setTimeout> | undefined;

		// Register cancel handle — also clears any pending sleep timer
		this.activeJobs.set(jobId, {
			cancel: () => {
				cancelled = true;
				if (pendingTimer !== undefined) {
					clearTimeout(pendingTimer);
					pendingTimer = undefined;
				}
			}
		});

		try {
			for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
				if (cancelled) {
					return { jobId, status: 'cancelled' };
				}

				const status = await client.getToolJobStatus(jobId);

				// Validate response belongs to the requested job
				if (status.job_id && status.job_id !== jobId) {
					continue; // Ignore mismatched response, retry
				}

				if (status.status === 'complete') {
					const result = await this.getResult(jobId);
					return { jobId, status: 'complete', result };
				}

				if (status.status === 'failed') {
					return { jobId, status: 'failed', error: status.message ?? 'Job failed' };
				}

				if (status.status === 'cancelled') {
					return { jobId, status: 'cancelled' };
				}

				// Wait before next poll (cancellable)
				await new Promise<void>(resolve => {
					pendingTimer = setTimeout(() => {
						pendingTimer = undefined;
						resolve();
					}, POLL_INTERVAL_MS);
				});
			}

			return { jobId, status: 'failed', error: 'Job timed out waiting for result' };
		} finally {
			this.activeJobs.delete(jobId);
		}
	}

	private mapServerResult(raw: ServerToolResult): ToolExecutionResult {
		return {
			testId: raw.test_id,
			testName: raw.test_name,
			statistic: raw.statistic,
			pValue: raw.p_value,
			criticalValues: raw.critical_values,
			conclusion: raw.conclusion,
			interpretation: raw.interpretation,
			details: raw.details,
			visualizations: raw.visualizations,
		};
	}

	private cancelAll(): void {
		for (const [, job] of this.activeJobs) {
			job.cancel();
		}
		this.activeJobs.clear();
	}
}
