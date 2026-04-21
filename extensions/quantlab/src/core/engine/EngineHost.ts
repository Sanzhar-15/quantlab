/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { EngineEvent, JobRequest } from '../../types/engine';
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

		const pythonPath = await this.resolvePythonPath();
		const engineRoot = this.resolveEngineRoot();

		const runner = new JobRunner({
			request,
			pythonPath,
			engineRoot,
			onEvent: event => this._onDidEmit.fire(event),
		});

		this.queue.add(request.jobId, runner);
		runner.start();
	}

	cancelJob(jobId: string): void {
		const runner = this.queue.get(jobId);
		if (!runner) {
			return;
		}
		runner.cancel();
		this.queue.remove(jobId);
	}

	completeJob(jobId: string): void {
		if (this.queue.has(jobId)) {
			this.queue.remove(jobId);
		}
	}

	private async resolvePythonPath(): Promise<string> {
		// CODEX-013: Check for bundled Python engine first
		const bundledPath = this.resolveBundledPython();
		if (bundledPath) {
			return bundledPath;
		}

		// Check VS Code Python extension setting
		const pythonConfig = vscode.workspace.getConfiguration('python');
		const pythonPath = pythonConfig.get<string>('defaultInterpreterPath');
		if (pythonPath && fs.existsSync(pythonPath)) {
			return pythonPath;
		}

		// Check Quantlab setting
		const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
		const customPython = quantlabConfig.get<string>('pythonPath');
		if (customPython && fs.existsSync(customPython)) {
			return customPython;
		}

		// Check managed venv Python (auto-installed dependencies)
		const managedPython = PythonBootstrap.getManagedPythonPath();
		if (managedPython && fs.existsSync(managedPython)) {
			return managedPython;
		}

		// Default to system Python
		return process.platform === 'win32' ? 'python' : 'python3';
	}

	/**
	 * CODEX-013: Check for bundled Python engine executable.
	 *
	 * The bundled engine is a PyInstaller-built standalone that doesn't require
	 * a system Python installation. It's checked in these locations:
	 * 1. Alongside the extension (engine-dist/quantlab-engine/)
	 * 2. Inside the extension resources (engine/quantlab-engine/)
	 */
	private resolveBundledPython(): string | null {
		const extensionPath = EngineHost.extensionUri?.fsPath;
		if (!extensionPath) {
			return null;
		}

		const exeName = process.platform === 'win32' ? 'quantlab-engine.exe' : 'quantlab-engine';

		const candidatePaths = [
			// Relative to extension root (development layout)
			path.join(extensionPath, '..', '..', 'engine-dist', 'quantlab-engine', exeName),
			// Inside extension resources (packaged layout)
			path.join(extensionPath, 'engine', 'quantlab-engine', exeName),
			// Build output directory
			path.join(extensionPath, '..', '..', '.build', 'dist', 'quantlab-engine', exeName),
		];

		for (const candidate of candidatePaths) {
			try {
				if (fs.existsSync(candidate)) {
					return candidate;
				}
			} catch {
				// Permission or path error — skip
			}
		}

		return null;
	}

	private resolveEngineRoot(): string {
		if (EngineHost.extensionUri) {
			return path.resolve(EngineHost.extensionUri.fsPath, '..', '..', 'engine');
		}
		// Fallback: walk up from this file's compiled location
		// extensions/quantlab/out/core/engine/ → extensions/quantlab/ → engine/
		return path.resolve(__dirname, '..', '..', '..', '..', '..', 'engine');
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
