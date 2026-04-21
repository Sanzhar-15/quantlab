/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Live Daemon Manager.
 *
 * Spawns and manages Python trading daemon processes.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import { ChildProcess, spawn } from 'child_process';
import { EventEmitter } from 'events';
import type TypedEmitter from 'typed-emitter';
import { generateToken, writeTokenFile, deleteTokenFile, socketExists } from '../ipc';

/**
 * Daemon process information.
 */
export interface DaemonProcess {
	sessionId: string;
	pid: number;
	process: ChildProcess;
	startTime: number;
	status: 'starting' | 'running' | 'stopping' | 'stopped' | 'error';
	error?: string;
}

/**
 * Daemon configuration.
 */
export interface DaemonConfig {
	sessionId: string;
	strategyPath: string;
	broker: string;
	symbols: string[];
	timeframe: string;
	paper: boolean;
	pythonPath?: string;
	riskLimits?: {
		maxExposure?: number;
		maxPositionSize?: number;
		maxDailyLoss?: number;
		dailyLossLimit?: number;
		maxDrawdownPercent?: number;
		consecutiveLossLimit?: number;
	};
}

/**
 * Daemon manager events.
 */
interface DaemonManagerEvents {
	'daemon.started': (sessionId: string, process: DaemonProcess) => void;
	'daemon.stopped': (sessionId: string, exitCode: number | null) => void;
	'daemon.error': (sessionId: string, error: Error) => void;
	'daemon.output': (sessionId: string, output: string) => void;
	[key: string]: (...args: any[]) => void;
}

/**
 * Daemon startup options.
 */
export interface DaemonStartOptions {
	waitForReady?: boolean;
	readyTimeoutMs?: number;
}

/**
 * Default daemon options.
 */
const DEFAULT_OPTIONS: Required<DaemonStartOptions> = {
	waitForReady: true,
	readyTimeoutMs: 30000,
};

/**
 * Manages Python trading daemon processes.
 */
export class LiveDaemonManager extends (EventEmitter as new () => TypedEmitter<DaemonManagerEvents>) {
	private static instance: LiveDaemonManager | undefined;

	private readonly daemons: Map<string, DaemonProcess> = new Map();
	private readonly outputChannels: Map<string, vscode.OutputChannel> = new Map();

	private constructor() {
		super();
	}

	/**
	 * Get singleton instance.
	 */
	static getInstance(): LiveDaemonManager {
		if (!LiveDaemonManager.instance) {
			LiveDaemonManager.instance = new LiveDaemonManager();
		}
		return LiveDaemonManager.instance;
	}

	/**
	 * Start a daemon process.
	 */
	async startDaemon(
		config: DaemonConfig,
		options: DaemonStartOptions = {}
	): Promise<DaemonProcess> {
		const opts = { ...DEFAULT_OPTIONS, ...options };

		// Check if already running
		if (this.daemons.has(config.sessionId)) {
			const existing = this.daemons.get(config.sessionId)!;
			if (existing.status === 'running' || existing.status === 'starting') {
				throw new Error(`Daemon already running for session ${config.sessionId}`);
			}
		}

		// Generate authentication token
		const token = generateToken();
		await writeTokenFile(config.sessionId, token);

		// Resolve Python path
		const pythonPath = config.pythonPath ?? await this.findPythonPath();

		// Build command arguments
		const args = this.buildDaemonArgs(config);

		// Create output channel
		const outputChannel = this.getOrCreateOutputChannel(config.sessionId);
		outputChannel.appendLine(`Starting daemon for session ${config.sessionId}...`);
		outputChannel.appendLine(`Python: ${pythonPath}`);
		outputChannel.appendLine(`Args: ${args.join(' ')}`);

		// Spawn the daemon process
		const childProcess = spawn(pythonPath, args, {
			cwd: path.dirname(config.strategyPath),
			env: {
				...process.env,
				QUANTLAB_SESSION_ID: config.sessionId,
				QUANTLAB_AUTH_TOKEN: token,
			},
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		const daemonProcess: DaemonProcess = {
			sessionId: config.sessionId,
			pid: childProcess.pid ?? -1,
			process: childProcess,
			startTime: Date.now(),
			status: 'starting',
		};

		this.daemons.set(config.sessionId, daemonProcess);

		// Handle stdout
		childProcess.stdout?.on('data', (data: Buffer) => {
			const output = data.toString();
			outputChannel.append(output);
			this.emit('daemon.output', config.sessionId, output);

			// Check for ready signal
			if (output.includes('DAEMON_READY')) {
				daemonProcess.status = 'running';
			}
		});

		// Handle stderr
		childProcess.stderr?.on('data', (data: Buffer) => {
			const output = data.toString();
			outputChannel.append(`[stderr] ${output}`);
		});

		// Handle process exit
		childProcess.on('exit', (code, signal) => {
			daemonProcess.status = 'stopped';
			outputChannel.appendLine(`Daemon exited with code ${code}, signal ${signal}`);
			this.emit('daemon.stopped', config.sessionId, code);

			// Cleanup
			this.daemons.delete(config.sessionId);
			deleteTokenFile(config.sessionId).catch(() => {});
		});

		// Handle process error
		childProcess.on('error', (error) => {
			daemonProcess.status = 'error';
			daemonProcess.error = error.message;
			outputChannel.appendLine(`Daemon error: ${error.message}`);
			this.emit('daemon.error', config.sessionId, error);
		});

		// Wait for daemon to be ready
		if (opts.waitForReady) {
			await this.waitForReady(config.sessionId, opts.readyTimeoutMs);
		}

		this.emit('daemon.started', config.sessionId, daemonProcess);
		return daemonProcess;
	}

	/**
	 * Stop a daemon process.
	 */
	async stopDaemon(sessionId: string): Promise<void> {
		const daemon = this.daemons.get(sessionId);
		if (!daemon) {
			return;
		}

		daemon.status = 'stopping';

		// Send SIGTERM for graceful shutdown
		daemon.process.kill('SIGTERM');

		// Wait for process to exit (with timeout)
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				// Force kill if graceful shutdown takes too long
				daemon.process.kill('SIGKILL');
				resolve();
			}, 5000);

			daemon.process.once('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		// Cleanup
		this.daemons.delete(sessionId);
		await deleteTokenFile(sessionId);
	}

	/**
	 * Get daemon status.
	 */
	getDaemonStatus(sessionId: string): DaemonProcess | undefined {
		return this.daemons.get(sessionId);
	}

	/**
	 * Check if daemon is running.
	 */
	isDaemonRunning(sessionId: string): boolean {
		const daemon = this.daemons.get(sessionId);
		return daemon?.status === 'running' || daemon?.status === 'starting';
	}

	/**
	 * Restart a daemon.
	 */
	async restartDaemon(sessionId: string, config: DaemonConfig): Promise<DaemonProcess> {
		await this.stopDaemon(sessionId);
		return this.startDaemon(config);
	}

	/**
	 * Get all running daemons.
	 */
	getAllDaemons(): DaemonProcess[] {
		return Array.from(this.daemons.values());
	}

	/**
	 * Stop all daemons.
	 */
	async stopAllDaemons(): Promise<void> {
		const sessionIds = Array.from(this.daemons.keys());
		await Promise.all(sessionIds.map(id => this.stopDaemon(id)));
	}

	/**
	 * Get or create output channel for a session.
	 */
	private getOrCreateOutputChannel(sessionId: string): vscode.OutputChannel {
		let channel = this.outputChannels.get(sessionId);
		if (!channel) {
			channel = vscode.window.createOutputChannel(`Quantlab Daemon: ${sessionId}`);
			this.outputChannels.set(sessionId, channel);
		}
		return channel;
	}

	/**
	 * Build daemon command arguments.
	 */
	private buildDaemonArgs(config: DaemonConfig): string[] {
		const args = [
			'-m', 'quantlab.daemon',
			'start',
			'--session-id', config.sessionId,
			'--strategy', config.strategyPath,
			'--broker', config.broker,
			'--timeframe', config.timeframe,
		];

		if (config.symbols.length > 0) {
			args.push('--symbols', ...config.symbols);
		}

		if (config.paper) {
			args.push('--paper');
		}

		if (config.riskLimits?.maxExposure) {
			args.push('--max-exposure', String(config.riskLimits.maxExposure));
		}

		if (config.riskLimits?.maxPositionSize) {
			args.push('--max-position-size', String(config.riskLimits.maxPositionSize));
		}

		if (config.riskLimits?.dailyLossLimit) {
			args.push('--daily-loss-limit', String(config.riskLimits.dailyLossLimit));
		}

		if (config.riskLimits?.maxDrawdownPercent) {
			args.push('--max-drawdown-percent', String(config.riskLimits.maxDrawdownPercent));
		}

		if (config.riskLimits?.consecutiveLossLimit) {
			args.push('--consecutive-loss-limit', String(config.riskLimits.consecutiveLossLimit));
		}

		return args;
	}

	/**
	 * Find Python executable path.
	 */
	private async findPythonPath(): Promise<string> {
		// Check VS Code Python extension setting
		const pythonConfig = vscode.workspace.getConfiguration('python');
		const pythonPath = pythonConfig.get<string>('defaultInterpreterPath');

		if (pythonPath) {
			return pythonPath;
		}

		// Check Quantlab setting
		const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
		const customPython = quantlabConfig.get<string>('pythonPath');

		if (customPython) {
			return customPython;
		}

		// Default to system Python
		return process.platform === 'win32' ? 'python' : 'python3';
	}

	/**
	 * Wait for daemon to be ready.
	 */
	private async waitForReady(sessionId: string, timeoutMs: number): Promise<void> {
		const startTime = Date.now();

		while (Date.now() - startTime < timeoutMs) {
			const daemon = this.daemons.get(sessionId);

			if (!daemon) {
				throw new Error('Daemon process not found');
			}

			if (daemon.status === 'error') {
				throw new Error(`Daemon failed to start: ${daemon.error}`);
			}

			if (daemon.status === 'running') {
				// Also check socket exists
				if (await socketExists(sessionId)) {
					return;
				}
			}

			// Wait and retry
			await new Promise(resolve => setTimeout(resolve, 500));
		}

		throw new Error(`Daemon startup timeout after ${timeoutMs}ms`);
	}

	/**
	 * Dispose output channels and listeners. Call only after stopAllDaemons() has settled.
	 */
	private disposeChannels(): void {
		for (const channel of this.outputChannels.values()) {
			channel.dispose();
		}
		this.outputChannels.clear();
		this.removeAllListeners();
	}

	/**
	 * Gracefully stop all daemons, then dispose channels.
	 * Async so deactivate() can await clean shutdown before extension unloads.
	 */
	static async resetInstance(): Promise<void> {
		if (LiveDaemonManager.instance) {
			const inst = LiveDaemonManager.instance;
			LiveDaemonManager.instance = undefined;
			try {
				await inst.stopAllDaemons();
			} catch {
				// Best effort — daemons may already be gone
			} finally {
				inst.disposeChannels();
			}
		}
	}
}

/**
 * Get the daemon sessions directory.
 */
export function getDaemonSessionsDir(): string {
	return path.join(os.homedir(), '.quantlab', 'sessions');
}

/**
 * List all session IDs with checkpoint files.
 */
export async function listDaemonSessions(): Promise<string[]> {
	const fs = await import('fs/promises');
	const sessionsDir = getDaemonSessionsDir();

	try {
		const files = await fs.readdir(sessionsDir);
		return files
			.filter(f => f.endsWith('.state'))
			.map(f => f.replace('.state', ''));
	} catch {
		return [];
	}
}
