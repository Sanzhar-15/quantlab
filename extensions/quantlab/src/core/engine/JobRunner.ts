/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { EngineEvent, JobLogEvent, JobRequest, JobResult } from '../../types/engine';

// CODEX-011: Job mode support for optimize, Monte Carlo, and WFA
export type JobMode = 'backtest' | 'optimize' | 'montecarlo' | 'wfa';

const MODULE_MAP: Record<JobMode, string> = {
	backtest: 'quantlab.cli.run_backtest',
	optimize: 'quantlab.cli.run_optimize',
	montecarlo: 'quantlab.cli.run_montecarlo',
	wfa: 'quantlab.cli.run_wfa',
};

export interface JobRunnerOptions {
	request: JobRequest;
	pythonPath: string;
	engineRoot: string;
	onEvent: (event: EngineEvent) => void;
}

export class JobRunner {
	private proc: ChildProcess | undefined;
	private cancelled = false;
	private finished = false;
	private stdoutChunks: Buffer[] = [];
	private stderrBuffer = '';
	private killTimer: NodeJS.Timeout | undefined;

	constructor(private readonly options: JobRunnerOptions) { }

	start(): void {
		const { request, pythonPath, engineRoot, onEvent } = this.options;
		const jobId = request.jobId;

		if (this.cancelled) {
			this.finished = true;
			onEvent({
				type: 'failed',
				jobId,
				error: 'Job was cancelled before it started.',
			});
			return;
		}

		this.emitLog('info', `Starting ${request.action} job via Python engine.`);

		const env = {
			...process.env,
			PYTHONPATH: engineRoot,
			PYTHONUNBUFFERED: '1',
		};

		// CODEX-011: Route to correct Python module based on action/mode
		const action = request.action as JobMode ?? 'backtest';
		const module = MODULE_MAP[action] ?? MODULE_MAP.backtest;

		this.proc = spawn(pythonPath, ['-m', module], {
			cwd: engineRoot,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// Write config JSON to stdin and close it
		const config = this.buildStdinConfig(request);
		try {
			this.proc.stdin!.end(JSON.stringify(config));
		} catch (err) {
			if (!this.finished) {
				this.finished = true;
				this.emitLog('error', `Failed to write to Python stdin: ${err}`);
				onEvent({
					type: 'failed',
					jobId,
					error: `Failed to write to Python engine stdin: ${err}`,
				});
			}
			return;
		}

		// Collect stdout (final result JSON)
		this.proc.stdout!.on('data', (chunk: Buffer) => {
			this.stdoutChunks.push(chunk);
		});

		// Parse stderr for NDJSON progress/log events
		this.proc.stderr!.on('data', (chunk: Buffer) => {
			this.stderrBuffer += chunk.toString();
			this.processStderrLines();
		});

		this.proc.on('error', (err) => {
			if (this.finished) {
				return;
			}
			this.finished = true;
			this.emitLog('error', `Failed to start Python process: ${err.message}`);
			onEvent({
				type: 'failed',
				jobId,
				error: `Failed to start Python engine: ${err.message}`,
			});
		});

		this.proc.on('close', (code) => {
			if (this.finished) {
				return;
			}
			this.finished = true;
			this.flushStderr();
			this.onProcessExit(code);
		});
	}

	cancel(): void {
		if (this.cancelled) {
			return;
		}
		this.cancelled = true;

		this.emitLog('warn', 'Job cancel requested.');

		if (this.proc && this.proc.exitCode === null) {
			try {
				this.proc.kill('SIGTERM');
			} catch {
				// Process already exited between check and kill — safe to ignore.
			}

			// Force kill after 5 seconds if still running
			this.killTimer = setTimeout(() => {
				if (this.proc && this.proc.exitCode === null) {
					try {
						this.proc.kill('SIGKILL');
					} catch {
						// Process already exited — safe to ignore.
					}
				}
			}, 5000);
		}
	}

	private buildStdinConfig(request: JobRequest): Record<string, unknown> {
		const values = request.config?.values ?? {};
		const action = request.action as JobMode ?? 'backtest';

		// Aggregate param.* keys into a flat params dict for the Python side
		const params: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(values)) {
			if (key.startsWith('param.')) {
				params[key.slice(6)] = value;
			}
		}

		const config: Record<string, unknown> = {
			jobId: request.jobId,
			strategyPath: request.strategyPath,
			mode: action,
			symbol: '',
			timeframe: '',
			dateStart: values.dateStart ?? null,
			dateEnd: values.dateEnd ?? null,
			dataSource: values.dataSource ?? '',
			initialCapital: values.initialCapital ?? 100000,
			commission: values.commission ?? 0.001,
			positionSize: values.positionSize ?? 100,
			params,
		};

		// CODEX-011: Mode-specific config
		if (action === 'optimize') {
			config.optimization = {
				parameters: values.optimizationParams ?? [],
				objective: values.objective ?? 'sharpe_ratio',
				method: values.optimizationMethod ?? 'grid',
			};
		} else if (action === 'montecarlo') {
			config.montecarlo = {
				simulations: values.simulations ?? 1000,
				confidence_levels: values.confidenceLevels ?? [0.95, 0.99],
			};
		} else if (action === 'wfa') {
			config.wfa = {
				in_sample_ratio: values.inSampleRatio ?? 0.7,
				windows: values.wfaWindows ?? 5,
				anchored: values.wfaAnchored ?? false,
			};
		}

		return config;
	}

	private processStderrLines(): void {
		while (this.stderrBuffer.includes('\n')) {
			const newlineIdx = this.stderrBuffer.indexOf('\n');
			const line = this.stderrBuffer.slice(0, newlineIdx).trim();
			this.stderrBuffer = this.stderrBuffer.slice(newlineIdx + 1);

			if (!line) {
				continue;
			}

			try {
				const msg = JSON.parse(line);
				this.handleStderrMessage(msg);
			} catch {
				// Non-JSON stderr output — emit as a log line
				this.emitLog('info', line);
			}
		}
	}

	private flushStderr(): void {
		const remaining = this.stderrBuffer.trim();
		this.stderrBuffer = '';
		if (!remaining) {
			return;
		}
		try {
			const msg = JSON.parse(remaining);
			this.handleStderrMessage(msg);
		} catch {
			this.emitLog('info', remaining);
		}
	}

	private handleStderrMessage(msg: unknown): void {
		if (typeof msg !== 'object' || msg === null || Array.isArray(msg)) {
			return;
		}
		const record = msg as Record<string, unknown>;
		const jobId = this.options.request.jobId;

		if (record.type === 'progress') {
			this.options.onEvent({
				type: 'progress',
				jobId,
				progress: Number(record.progress) || 0,
				message: String(record.message ?? ''),
			});
		} else if (record.type === 'log') {
			const level = record.level as JobLogEvent['level'] | undefined;
			this.options.onEvent({
				type: 'log',
				jobId,
				timestamp: String(record.timestamp ?? new Date().toISOString()),
				message: String(record.message ?? ''),
				level: level ?? 'info',
			});
		}
	}

	private onProcessExit(code: number | null): void {
		if (this.killTimer) {
			clearTimeout(this.killTimer);
			this.killTimer = undefined;
		}

		const jobId = this.options.request.jobId;

		if (this.cancelled) {
			this.options.onEvent({
				type: 'failed',
				jobId,
				error: 'Job cancelled by user.',
			});
			return;
		}

		// Parse stdout as JSON result
		const stdoutStr = Buffer.concat(this.stdoutChunks).toString().trim();

		if (!stdoutStr) {
			this.options.onEvent({
				type: 'failed',
				jobId,
				error: `Python process exited with code ${code} and produced no output.`,
			});
			return;
		}

		let parsed: Record<string, unknown>;
		try {
			const raw: unknown = JSON.parse(stdoutStr);
			if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
				this.options.onEvent({
					type: 'failed',
					jobId,
					error: `Python output is not a JSON object. Exit code: ${code}`,
				});
				return;
			}
			parsed = raw as Record<string, unknown>;
		} catch {
			this.options.onEvent({
				type: 'failed',
				jobId,
				error: `Failed to parse Python output as JSON. Exit code: ${code}`,
			});
			return;
		}

		if (parsed.success === false) {
			this.options.onEvent({
				type: 'failed',
				jobId,
				error: String(parsed.error ?? 'Unknown error from Python engine'),
				stack: parsed.stack ? String(parsed.stack) : undefined,
			});
			return;
		}

		// Build JobResult from parsed output
		const result: JobResult = {
			metrics: (parsed.metrics as Record<string, number>) ?? {},
			warnings: (parsed.warnings as string[]) ?? [],
			equity: (parsed.equity as Array<{ t: number; v: number }>) ?? [],
			signals: (parsed.signals as Array<{ t: number; type: 'entry' | 'exit'; label?: string; price?: number }>) ?? [],
		};

		this.options.onEvent({
			type: 'complete',
			jobId,
			result,
		});
	}

	private emitLog(level: JobLogEvent['level'], message: string): void {
		this.options.onEvent({
			type: 'log',
			jobId: this.options.request.jobId,
			timestamp: new Date().toISOString(),
			message,
			level,
		});
	}
}
