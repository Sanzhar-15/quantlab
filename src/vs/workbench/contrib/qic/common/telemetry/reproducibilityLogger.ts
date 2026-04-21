/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import type { ProviderRequest, ProviderResponse } from '../canonical/types.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

/**
 * Reproducibility logger — records all LLM requests/responses as JSONL.
 *
 * Stored in {workspaceStorage}/recordings/ for later replay.
 * Each line is a JSON object with: timestamp, request, response.
 */
export class ReproducibilityLogger {

	private readonly recordingsDir: string;
	private currentSessionFile: string | null = null;
	private enabled = false;

	constructor(workspaceStoragePath: string) {
		this.recordingsDir = path.join(workspaceStoragePath, 'recordings');
	}

	/**
	 * Enable recording for the current session.
	 */
	async startRecording(): Promise<string> {
		const fs = await fsPromises();
		await fs.mkdir(this.recordingsDir, { recursive: true });

		const sessionId = new Date().toISOString().replace(/[:.]/g, '-');
		this.currentSessionFile = path.join(this.recordingsDir, `session-${sessionId}.jsonl`);
		this.enabled = true;

		return this.currentSessionFile;
	}

	/**
	 * Stop recording.
	 */
	stopRecording(): void {
		this.enabled = false;
		this.currentSessionFile = null;
	}

	/**
	 * Log an LLM request/response pair.
	 * Strips AbortSignal from the request (not serializable).
	 */
	async logRequest(request: ProviderRequest, response: ProviderResponse): Promise<void> {
		const fs = await fsPromises();
		if (!this.enabled || !this.currentSessionFile) {
			return;
		}

		const entry = {
			timestamp: new Date().toISOString(),
			request: {
				model: request.model,
				messages: request.messages,
				tools: request.tools,
				temperature: request.temperature,
				maxTokens: request.maxTokens,
				stream: request.stream,
				// Intentionally omit `signal` — not serializable
			},
			response: {
				content: response.content,
				usage: response.usage,
				stopReason: response.stopReason,
			},
		};

		const line = JSON.stringify(entry) + '\n';
		await fs.appendFile(this.currentSessionFile, line, 'utf-8');
	}

	/**
	 * Get the current recording file path.
	 */
	async getRecordingPath(): Promise<string> {
		if (this.currentSessionFile) {
			return this.currentSessionFile;
		}
		return this.recordingsDir;
	}

	/**
	 * List all available recording files.
	 */
	async listRecordings(): Promise<string[]> {
		const fs = await fsPromises();
		try {
			const entries = await fs.readdir(this.recordingsDir);
			return entries
				.filter(e => e.endsWith('.jsonl'))
				.map(e => path.join(this.recordingsDir, e))
				.sort();
		} catch {
			return [];
		}
	}

	/**
	 * Read a recording file and return parsed entries.
	 */
	async readRecording(recordingPath: string): Promise<Array<{
		timestamp: string;
		request: Omit<ProviderRequest, 'signal'>;
		response: ProviderResponse;
	}>> {
		const fs = await fsPromises();
		const content = await fs.readFile(recordingPath, 'utf-8');
		const lines = content.trim().split('\n').filter(l => l.length > 0);
		return lines.map(line => JSON.parse(line));
	}

	/**
	 * Check if recording is currently active.
	 */
	isRecording(): boolean {
		return this.enabled;
	}
}
