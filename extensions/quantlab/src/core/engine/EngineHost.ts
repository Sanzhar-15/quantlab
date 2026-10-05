/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EngineEvent, JobRequest } from '../../types/engine';
import { bundledEngineLaunch, EngineLaunch, resolveBundledEngine } from './bundledEngine';
import { JobQueue } from './JobQueue';
import { JobRunner } from './JobRunner';
import { PythonBootstrap } from './PythonBootstrap';

export class EngineHost {
	private static instance: EngineHost | undefined;
	private static extensionUri: vscode.Uri | undefined;

	private readonly queue = new JobQueue();
	private readonly _onDidEmit = new vscode.EventEmitter<EngineEvent>();
	readonly onDidEmit = this._onDidEmit.event;

	private constructor() { }

	static initialize(uri: vscode.Uri): void {
		EngineHost.extensionUri = uri;
	}

	static getInstance(): EngineHost {
		if (!EngineHost.instance) {
			EngineHost.instance = new EngineHost();
		}
		return EngineHost.instance;
	}

	async runJob(request: JobRequest): Promise<void> {
		if (this.queue.has(request.jobId)) {
			return;
		}

		// A launch that cannot be resolved fails the job visibly, naming why.
		let engine: EngineLaunch;
		try {
			engine = this.resolveLaunch();
		} catch (err: unknown) {
			this._onDidEmit.fire({
				type: 'failed',
				jobId: request.jobId,
				error: err instanceof Error ? err.message : String(err),
			});
			return;
		}

		const runner = new JobRunner({
			request,
			engine,
			onEvent: event => this._onDidEmit.fire(event),
		});

		this.queue.add(request.jobId, runner);
		runner.start();
	}

	/** Returns true if a running job was found and cancelled, false if no such job is active. */
	cancelJob(jobId: string): boolean {
		const runner = this.queue.get(jobId);
		if (!runner) {
			return false;
		}
		runner.cancel();
		this.queue.remove(jobId);
		return true;
	}

	completeJob(jobId: string): void {
		if (this.queue.has(jobId)) {
			this.queue.remove(jobId);
		}
	}

	/**
	 * CODEX-013: the bundled (PyInstaller) engine first; without one, a Python interpreter
	 * running the engine source tree.
	 */
	private resolveLaunch(): EngineLaunch {
		const extensionPath = this.extensionPath();
		const bundled = resolveBundledEngine(extensionPath, process.platform);
		if (bundled) {
			return bundledEngineLaunch(bundled);
		}

		const { executable, source } = this.resolveInterpreter();
		const engineRoot = path.resolve(extensionPath, '..', '..', 'engine');
		if (!fs.statSync(engineRoot, { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`Quantlab: no bundled engine was found and the engine source tree ${engineRoot} does not exist, so ${executable} (${source}) cannot run the engine.`);
		}
		return { executable, source, cwd: engineRoot, engineRoot };
	}

	// FLAGGED (law section 4, pre-existing): settings to managed venv to a bare system python3 is a
	// silent chain; the job's first log line names the one taken.
	private resolveInterpreter(): { executable: string; source: string } {
		// Check VS Code Python extension setting
		const pythonConfig = vscode.workspace.getConfiguration('python');
		const pythonPath = pythonConfig.get<string>('defaultInterpreterPath');
		if (pythonPath && fs.existsSync(pythonPath)) {
			return { executable: pythonPath, source: 'setting python.defaultInterpreterPath' };
		}

		// Check Quantlab setting
		const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
		const customPython = quantlabConfig.get<string>('pythonPath');
		if (customPython && fs.existsSync(customPython)) {
			return { executable: customPython, source: 'setting quantlab.pythonPath' };
		}

		// Check managed venv Python (auto-installed dependencies)
		const managedPython = PythonBootstrap.getManagedPythonPath();
		if (managedPython && fs.existsSync(managedPython)) {
			return { executable: managedPython, source: 'managed venv' };
		}

		// Default to system Python
		return { executable: process.platform === 'win32' ? 'python' : 'python3', source: 'system Python on PATH' };
	}

	private extensionPath(): string {
		if (!EngineHost.extensionUri) {
			throw new Error('Quantlab: the engine host was not initialized with the extension location (EngineHost.initialize).');
		}
		return EngineHost.extensionUri.fsPath;
	}

	dispose(): void {
		// Cancel all queued jobs
		for (const jobId of this.queue.keys()) {
			this.cancelJob(jobId);
		}
		this._onDidEmit.dispose();
	}

	static resetInstance(): void {
		if (EngineHost.instance) {
			EngineHost.instance.dispose();
			EngineHost.instance = undefined;
		}
	}
}
