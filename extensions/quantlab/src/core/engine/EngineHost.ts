/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { EngineEvent, JobRequest } from '../../types/engine';
import { EngineLaunch, selectEngine } from './bundledEngine';
import { JobQueue } from './JobQueue';
import { JobRunner } from './JobRunner';

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

	/** The engine of {@link selectEngine}; `quantlab.pythonPath` counts only when the user set it. */
	private resolveLaunch(): EngineLaunch {
		// The contributed default is '': a non-empty value is one the user set.
		const explicitPython = vscode.workspace.getConfiguration('quantlab').get<string>('pythonPath');
		if (explicitPython === undefined) {
			throw new Error('Quantlab: the setting quantlab.pythonPath is not contributed by this extension.');
		}
		return selectEngine({ extensionPath: this.extensionPath(), appRoot: vscode.env.appRoot, platform: process.platform, explicitPython });
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
