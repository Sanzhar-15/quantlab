/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import * as path from '../../../../../base/common/path.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CheckpointValidation {
	valid: boolean;
	failures: CheckpointFailure[];
}

export interface CheckpointFailure {
	rule: 'CV-1' | 'CV-2' | 'CV-3' | 'CV-4' | 'CV-5';
	message: string;
}

export interface CheckpointData {
	schemaVersion: number;
	timestamp: string;
	checksum: string;
	files: Array<{ path: string; hash: string; deleted?: boolean }>;
	metadata?: Record<string, unknown>;
}

const CURRENT_SCHEMA_VERSION = 1;
const QUARANTINE_DIR = '.quarantine';

// ---------------------------------------------------------------------------
// CheckpointValidator
// ---------------------------------------------------------------------------

/**
 * Validates checkpoints against the five checkpoint validity rules (CV-1..CV-5).
 * Invalid checkpoints are quarantined (moved, not deleted).
 */
export class CheckpointValidator {

	constructor(
		private readonly workspaceRoot: string,
	) {}

	/**
	 * Validate a checkpoint file against all 5 rules.
	 */
	async validate(checkpointPath: string, previousTimestamp?: string): Promise<CheckpointValidation> {
		const fs = await fsPromises();
		const failures: CheckpointFailure[] = [];

		// CV-1: Complete marker required
		const completePath = checkpointPath + '.complete';
		try {
			await fs.access(completePath);
		} catch {
			failures.push({
				rule: 'CV-1',
				message: 'Missing .complete marker — checkpoint may be from an interrupted write',
			});
		}

		// Read the checkpoint data (needed for CV-2 through CV-5)
		let data: CheckpointData;
		try {
			const raw = await fs.readFile(checkpointPath, 'utf-8');
			data = JSON.parse(raw);
		} catch (e) {
			failures.push({
				rule: 'CV-2',
				message: `Checkpoint unreadable: ${e}`,
			});
			return { valid: false, failures };
		}

		// CV-2: Checksum integrity
		const computed = this._computeChecksum(data);
		if (computed !== data.checksum) {
			failures.push({
				rule: 'CV-2',
				message: `Checksum mismatch: expected ${data.checksum}, got ${computed}`,
			});
		}

		// CV-3: Schema version compatibility
		if (data.schemaVersion > CURRENT_SCHEMA_VERSION) {
			failures.push({
				rule: 'CV-3',
				message: `Schema version ${data.schemaVersion} is from a newer QIC version (current: ${CURRENT_SCHEMA_VERSION})`,
			});
		}

		// CV-4: Timestamp monotonicity
		if (previousTimestamp && data.timestamp <= previousTimestamp) {
			failures.push({
				rule: 'CV-4',
				message: `Checkpoint timestamp ${data.timestamp} is not newer than previous ${previousTimestamp}`,
			});
		}

		// CV-5: Referential integrity
		for (const file of data.files) {
			if (file.deleted) {
				continue; // Explicitly marked as deleted — OK
			}
			const fullPath = path.resolve(this.workspaceRoot, file.path);
			try {
				await fs.access(fullPath);
			} catch {
				failures.push({
					rule: 'CV-5',
					message: `Referenced file missing: ${file.path}`,
				});
			}
		}

		return {
			valid: failures.length === 0,
			failures,
		};
	}

	/**
	 * Quarantine an invalid checkpoint (move to .quarantine/).
	 */
	async quarantine(checkpointPath: string, reason: string): Promise<void> {
		const fs = await fsPromises();
		const dir = path.dirname(checkpointPath);
		const quarantineDir = path.join(dir, QUARANTINE_DIR);
		await fs.mkdir(quarantineDir, { recursive: true });

		const basename = path.basename(checkpointPath);
		const dest = path.join(quarantineDir, basename);
		await fs.rename(checkpointPath, dest);

		// Also move .complete marker if it exists
		const completePath = checkpointPath + '.complete';
		try {
			await fs.rename(completePath, dest + '.complete');
		} catch {
			// No marker — fine
		}

		// Write reason file
		await fs.writeFile(dest + '.quarantine-reason', reason, 'utf-8');
	}

	// -- Private ---------------------------------------------------------------

	private _computeChecksum(data: CheckpointData): string {
		// Checksum covers everything except the checksum field itself and file content.
		// Must match the computation in TransactionSafeCheckpointManager.createCheckpoint().
		const toHash = {
			schemaVersion: data.schemaVersion,
			timestamp: data.timestamp,
			files: data.files.map(f => ({ path: f.path, hash: f.hash, deleted: f.deleted })),
			metadata: data.metadata,
		};
		return sha256Hex(JSON.stringify(toHash));
	}
}
