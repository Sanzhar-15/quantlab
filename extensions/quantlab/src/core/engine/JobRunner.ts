/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'child_process';
import { EngineEvent, JobLogEvent, JobRequest, JobResult } from '../../types/engine';
import { EngineLaunch } from './bundledEngine';

// The engine module each job action runs.
const MODULE_MAP: ReadonlyMap<string, string> = new Map([
	['backtest', 'quantlab.cli.run_backtest'],
]);

// Actions the product offers that have no engine module yet: refused by name, never started.
const UNAVAILABLE_ACTIONS: ReadonlyMap<string, string> = new Map([
	['optimize', 'Optimize'],
	['monteCarlo', 'Monte Carlo'],
	['wfa', 'Walk-forward analysis'],
]);

/** The engine module an action runs, or why it cannot run. */
export function resolveEngineModule(action: string): { kind: 'module'; module: string } | { kind: 'refused'; reason: string } {
	const module = MODULE_MAP.get(action);
	if (module) {
		return { kind: 'module', module };
	}
	const label = UNAVAILABLE_ACTIONS.get(action);
	if (label) {
		return { kind: 'refused', reason: `${label} is not available yet: the Quantlab engine has no ${label} module.` };
	}
	return { kind: 'refused', reason: `Unknown engine action '${action}': the Quantlab engine runs only a backtest.` };
}

export interface JobRunnerOptions {
	request: JobRequest;
	engine: EngineLaunch;
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
		const { request, engine, onEvent } = this.options;
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

		const resolved = resolveEngineModule(request.action);
		if (resolved.kind === 'refused') {
			this.finished = true;
			this.emitLog('error', resolved.reason);
			onEvent({
				type: 'failed',
				jobId,
				error: resolved.reason,
			});
			return;
		}
		const module = resolved.module;

		this.emitLog('info', `Starting ${request.action} job: ${engine.executable} -m ${module} (${engine.source}; cwd ${engine.cwd})`);

		const env: NodeJS.ProcessEnv = {
			...process.env,
			PYTHONUNBUFFERED: '1',
		};
		if (engine.engineRoot === null) {
			delete env.PYTHONPATH;
		} else {
			env.PYTHONPATH = engine.engineRoot;
		}

		this.proc = spawn(engine.executable, ['-m', module], {
			cwd: engine.cwd,
			env,
			stdio: ['pipe', 'pipe', 'pipe'],
		});

		// A failed write to the engine's stdin (EPIPE: the engine exited without reading its config) is an
		// 'error' event on the stream, never a throw from end(). It is recorded here, and the job's outcome
		// waits until stdin has settled, so the order of 'close' and the error cannot change the result.
		const stdin = this.proc.stdin!;
		const stdinSettled = new Promise<Error | undefined>(resolve => {
			stdin.on('error', err => resolve(err));
			stdin.once('finish', () => resolve(undefined));
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
			void stdinSettled.then(stdinError => {
				if (this.finished) {
					return;
				}
				this.finished = true;
				this.flushStderr();
				if (stdinError !== undefined && !this.cancelled) {
					this.emitLog('error', `The engine did not read its job config from stdin: ${stdinError.message}`);
					onEvent({
						type: 'failed',
						jobId,
						error: `The engine exited (code ${code}) without reading its job config: ${stdinError.message}`,
					});
					return;
				}
				this.onProcessExit(code);
			});
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
				// Process already exited between check and kill: safe to ignore.
			}

			// Force kill after 5 seconds if still running
			this.killTimer = setTimeout(() => {
				if (this.proc && this.proc.exitCode === null) {
					try {
						this.proc.kill('SIGKILL');
					} catch {
						// Process already exited: safe to ignore.
					}
				}
			}, 5000);
		}
	}

	private buildStdinConfig(request: JobRequest): Record<string, unknown> {
		const values = request.config?.values ?? {};

		// Aggregate param.* keys into a flat params dict for the Python side
		const params: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(values)) {
			if (key.startsWith('param.')) {
				params[key.slice(6)] = value;
			}
		}

		return {
			jobId: request.jobId,
			strategyPath: request.strategyPath,
			mode: request.action,
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
				// Non-JSON stderr output: emit as a log line
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
