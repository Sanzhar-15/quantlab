/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID, sha256Hex } from '../qicCrypto.js';
import * as path from '../../../../../base/common/path.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}
import type { JournaledAtomicWriter } from './journaledAtomicWriter.js';
import type { CheckpointValidator } from './checkpointValidity.js';
import type { OptimizedSecretScanner } from '../security/secretScanner.js';

export interface CheckpointInfo {
	id: string;
	createdAt: string;
	fileCount: number;
	metadata?: Record<string, unknown>;
}

export interface CheckpointFileEntry {
	path: string;
	hash: string;
	content?: string;
	deleted?: boolean;
}

export interface CheckpointData {
	schemaVersion: number;
	timestamp: string;
	files: CheckpointFileEntry[];
	metadata?: Record<string, unknown>;
	checksum: string;
}

export interface ExportedCheckpoint {
	id: string;
	data: CheckpointData;
	redactionCount: number;
}

/**
 * Crash-safe checkpoint creation and restoration.
 * Remediation Fix 3b / Audit VII-DS17: Includes secret scanning at export.
 */
export class TransactionSafeCheckpointManager {
	constructor(
		private readonly atomicWriter: JournaledAtomicWriter,
		private readonly validator: CheckpointValidator,
		private readonly secretScanner: OptimizedSecretScanner,
		private readonly checkpointDir: string,
	) {}

	async createCheckpoint(
		filePaths: string[],
		metadata?: Record<string, unknown>,
	): Promise<string> {
		const fs = await fsPromises();
		const checkpointId = randomUUID();
		const files: CheckpointFileEntry[] = [];

		for (const filePath of filePaths) {
			try {
				const content = await fs.readFile(filePath, 'utf8');
				const hash = sha256Hex(content);
				files.push({ path: filePath, hash, content });
			} catch {
				// File doesn't exist — mark as deleted
				files.push({ path: filePath, hash: '', deleted: true });
			}
		}

		const timestamp = new Date().toISOString();
		const checksumData = JSON.stringify({
			schemaVersion: 1,
			timestamp,
			files: files.map(f => ({ path: f.path, hash: f.hash, deleted: f.deleted })),
			metadata,
		});
		const checksum = sha256Hex(checksumData);

		const data: CheckpointData = {
			schemaVersion: 1,
			timestamp,
			files,
			metadata,
			checksum,
		};

		const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.checkpoint`);
		await fs.mkdir(this.checkpointDir, { recursive: true });

		await this.atomicWriter.writeAtomic([
			{ type: 'write', path: checkpointPath, content: Buffer.from(JSON.stringify(data)) },
			{ type: 'write', path: checkpointPath + '.complete', content: Buffer.from('') },
		]);

		return checkpointId;
	}

	async restoreCheckpoint(checkpointId: string): Promise<void> {
		const fs = await fsPromises();
		const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.checkpoint`);

		// Verify .complete sentinel exists (crash safety — ensures checkpoint was fully written)
		const completePath = checkpointPath + '.complete';
		try {
			await fs.access(completePath);
		} catch {
			throw new Error(`Checkpoint ${checkpointId} is incomplete (missing .complete sentinel)`);
		}

		const validationResult = await this.validator.validate(checkpointPath);

		if (!validationResult.valid) {
			const reasons = validationResult.failures.map(f => `${f.rule}: ${f.message}`).join(', ');
			throw new Error(`Checkpoint validation failed: ${reasons}`);
		}

		const raw = await fs.readFile(checkpointPath, 'utf8');
		const data: CheckpointData = JSON.parse(raw);

		// Verify schema version
		if (data.schemaVersion !== 1) {
			throw new Error(`Unsupported checkpoint schema version: ${data.schemaVersion}`);
		}

		const operations: Array<{ type: 'write' | 'delete'; path: string; content?: Uint8Array }> = [];

		for (const file of data.files) {
			if (file.deleted) {
				// File did not exist at checkpoint time — delete it if it exists now
				operations.push({ type: 'delete', path: file.path });
			} else if (file.content !== undefined) {
				operations.push({ type: 'write', path: file.path, content: Buffer.from(file.content) });
			}
		}

		if (operations.length > 0) {
			await this.atomicWriter.writeAtomic(operations);
		}
	}

	/**
	 * Export checkpoint with secret redaction (Audit VII-DS17 / INV-T3).
	 */
	async exportCheckpoint(checkpointId: string): Promise<ExportedCheckpoint> {
		const fs = await fsPromises();
		const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.checkpoint`);
		const raw = await fs.readFile(checkpointPath, 'utf8');
		const data: CheckpointData = JSON.parse(raw);

		let redactionCount = 0;

		for (const file of data.files) {
			if (file.content) {
				const scanResult = this.secretScanner.scan(file.content);
				if (scanResult.hasSecrets) {
					file.content = scanResult.redactedText;
					redactionCount += scanResult.findings.length;
				}
			}
		}

		return { id: checkpointId, data, redactionCount };
	}

	async listCheckpoints(): Promise<CheckpointInfo[]> {
		try {
			const fs = await fsPromises();
			const entries = await fs.readdir(this.checkpointDir);
			const checkpoints: CheckpointInfo[] = [];

			for (const entry of entries) {
				if (!entry.endsWith('.checkpoint')) { continue; }

				const checkpointPath = path.join(this.checkpointDir, entry);
				try {
					const raw = await fs.readFile(checkpointPath, 'utf8');
					const data: CheckpointData = JSON.parse(raw);
					checkpoints.push({
						id: entry.replace('.checkpoint', ''),
						createdAt: data.timestamp,
						fileCount: data.files.length,
						metadata: data.metadata,
					});
				} catch {
					// Skip corrupt checkpoints
				}
			}

			return checkpoints;
		} catch {
			return [];
		}
	}

	async deleteCheckpoint(checkpointId: string): Promise<void> {
		const fs = await fsPromises();
		const checkpointPath = path.join(this.checkpointDir, `${checkpointId}.checkpoint`);
		await fs.rm(checkpointPath, { force: true });
		await fs.rm(checkpointPath + '.complete', { force: true });
	}
}
