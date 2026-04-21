/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID, sha256Hex } from '../qicCrypto.js';
import * as path from '../../../../../base/common/path.js';

let _fsPromises: typeof import('fs/promises') | null = null;
let _fsChecked = false;
async function fsPromises(): Promise<typeof import('fs/promises') | null> {
	if (!_fsChecked) {
		_fsChecked = true;
		try {
			// @ts-ignore — dynamic import; unavailable in sandboxed renderer
			_fsPromises = await import('fs/promises');
		} catch {
			_fsPromises = null;
		}
	}
	return _fsPromises;
}
import { FileOperation, JournalEntry, JournalOperation, RecoveryResult } from './types.js';

async function requireFs(): Promise<typeof import('fs/promises')> {
	const fs = await fsPromises();
	if (!fs) {
		throw new Error('QIC-J005: File system unavailable (sandboxed renderer). Atomic file operations require Node.js fs access.');
	}
	return fs;
}

const JOURNAL_EXT = '.journal';
const BACKUP_DIR = '.backups';
const QUARANTINE_DIR = '.quarantine';

/**
 * Crash-safe atomic file writer using a write-ahead journal.
 *
 * Protocol:
 *   1. Write journal (all operations + checksums) to `.journal` file
 *   2. fsync journal to ensure durable write
 *   3. Execute operations (create backups first for rollback)
 *   4. Delete journal on success
 *
 * On crash recovery, incomplete journals are replayed or rolled back.
 */
export class JournaledAtomicWriter {

	private _storageType: 'ssd' | 'hdd' | 'unknown' = 'unknown';
	private _batchQueue: Array<{ ops: FileOperation[]; resolve: () => void; reject: (e: Error) => void }> = [];
	private _batchTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly _batchWindowMs = 50;

	constructor(
		private readonly journalDir: string,
	) {}

	// -- Public API -----------------------------------------------------------

	/**
	 * Execute a batch of file operations atomically.
	 * Either ALL operations succeed, or ALL are rolled back.
	 */
	async writeAtomic(operations: FileOperation[]): Promise<void> {
		if (this._storageType === 'hdd') {
			return this._enqueueBatched(operations);
		}
		return this._executeTransaction(operations);
	}

	/**
	 * Recover from a crash by replaying or rolling back incomplete journals.
	 */
	static async recoverFromCrash(journalDir: string): Promise<RecoveryResult> {
		const result: RecoveryResult = {
			recovered: false,
			journalsProcessed: 0,
			operationsRolledForward: 0,
			operationsRolledBack: 0,
			errors: [],
		};

		const fs = await fsPromises();
		if (!fs) {
			// fs/promises unavailable (sandboxed renderer) — nothing to recover
			return result;
		}

		let files: string[];
		try {
			files = await fs.readdir(journalDir);
		} catch {
			return result; // No journal dir — nothing to recover
		}

		const journalFiles = files.filter(f => f.endsWith(JOURNAL_EXT)).sort();
		if (journalFiles.length === 0) {
			return result;
		}

		for (const file of journalFiles) {
			const journalPath = path.join(journalDir, file);
			try {
				const raw = await fs.readFile(journalPath, 'utf-8');
				const entry: JournalEntry = JSON.parse(raw);

				// Validate checksum
				const computed = JournaledAtomicWriter._computeChecksum(entry.operations);
				if (computed !== entry.checksum) {
					// QIC-J001: JournalCorrupt — quarantine
					await JournaledAtomicWriter._quarantine(journalDir, journalPath, 'QIC-J001: Checksum mismatch');
					result.errors.push(`QIC-J001: Journal ${file} corrupted (checksum mismatch), quarantined`);
					result.journalsProcessed++;
					continue;
				}

				// Determine completion status
				const statuses = await JournaledAtomicWriter._checkOperationStatuses(entry.operations);
				const completedCount = statuses.filter(s => s === 'completed').length;
				const total = entry.operations.length;

				if (completedCount === total) {
					// All done — just clean up
					await fs.unlink(journalPath);
				} else if (completedCount === 0) {
					// Nothing started — safe to delete
					await fs.unlink(journalPath);
				} else {
					// Partial — roll forward remaining operations
					for (let i = 0; i < total; i++) {
						if (statuses[i] !== 'completed') {
							try {
								await JournaledAtomicWriter._executeOp(entry.operations[i]);
								result.operationsRolledForward++;
							} catch (e) {
								result.errors.push(`QIC-J003: Roll-forward failed for ${entry.operations[i].targetPath}: ${e}`);
							}
						}
					}
					await fs.unlink(journalPath);
				}

				result.journalsProcessed++;
				result.recovered = true;
			} catch (e) {
				await JournaledAtomicWriter._quarantine(journalDir, journalPath, `QIC-J001: Parse error: ${e}`);
				result.errors.push(`QIC-J001: Journal ${file} unreadable, quarantined`);
				result.journalsProcessed++;
			}
		}

		return result;
	}

	/**
	 * Check if there are incomplete journals.
	 */
	static async hasIncompleteJournals(journalDir: string): Promise<boolean> {
		try {
			const fs = await fsPromises();
			if (!fs) { return false; }
			const files = await fs.readdir(journalDir);
			return files.some(f => f.endsWith(JOURNAL_EXT));
		} catch {
			return false;
		}
	}

	/**
	 * Detect whether storage is SSD or HDD via a 4KB write benchmark.
	 * If fsync latency > 20ms, storage is likely HDD.
	 */
	async detectStorageType(): Promise<'ssd' | 'hdd' | 'unknown'> {
		const fs = await fsPromises();
		if (!fs) { this._storageType = 'unknown'; return 'unknown'; }
		const testFile = path.join(this.journalDir, '.speed-test');
		try {
			const fh = await fs.open(testFile, 'w');
			const buf = Buffer.alloc(4096);
			const start = performance.now();
			await fh.write(buf);
			await fh.datasync();
			const latency = performance.now() - start;
			await fh.close();
			await fs.unlink(testFile).catch(() => { });

			if (latency > 20) {
				console.warn(
					`[QIC] Detected slow storage (${latency.toFixed(1)}ms fsync). Batching journal writes.`
				);
				this._storageType = 'hdd';
				return 'hdd';
			}
			this._storageType = 'ssd';
			return 'ssd';
		} catch {
			this._storageType = 'unknown';
			return 'unknown';
		}
	}

	// -- Private: Transaction Execution ----------------------------------------

	private async _executeTransaction(operations: FileOperation[]): Promise<void> {
		const fs = await requireFs();
		const transactionId = randomUUID();
		const journalOps = await this._prepareJournalOps(operations, transactionId);

		const entry: JournalEntry = {
			version: 1,
			transactionId,
			timestamp: new Date().toISOString(),
			operations: journalOps,
			checksum: JournaledAtomicWriter._computeChecksum(journalOps),
		};

		const journalPath = path.join(this.journalDir, `${transactionId}${JOURNAL_EXT}`);

		// Phase 1: Write journal
		await fs.mkdir(this.journalDir, { recursive: true });
		const fh = await fs.open(journalPath, 'w');
		await fh.writeFile(JSON.stringify(entry), 'utf-8');
		// Phase 2: fsync journal
		await fh.datasync();
		await fh.close();

		// Phase 3: Execute operations (with backups for rollback)
		let executedCount = 0;
		try {
			for (const op of journalOps) {
				await JournaledAtomicWriter._executeOp(op);
				executedCount++;
			}
		} catch (err) {
			// Roll back completed operations
			for (let i = executedCount - 1; i >= 0; i--) {
				try {
					await JournaledAtomicWriter._rollbackOp(journalOps[i]);
				} catch {
					// QIC-J004: RollBackFailed — best effort
				}
			}
			await fs.unlink(journalPath).catch(() => { });
			throw err;
		}

		// Phase 4: Delete journal on success
		await fs.unlink(journalPath).catch(() => { });

		// Clean up backups
		const backupDir = path.join(this.journalDir, BACKUP_DIR, transactionId);
		await fs.rm(backupDir, { recursive: true, force: true }).catch(() => { });
	}

	private async _prepareJournalOps(operations: FileOperation[], txId: string): Promise<JournalOperation[]> {
		const fs = await requireFs();
		const backupDir = path.join(this.journalDir, BACKUP_DIR, txId);
		await fs.mkdir(backupDir, { recursive: true });

		const journalOps: JournalOperation[] = [];

		for (let i = 0; i < operations.length; i++) {
			const op = operations[i];
			const jop: JournalOperation = {
				type: op.type,
				targetPath: op.path,
			};

			if (op.type === 'write' && op.content) {
				// Create backup of existing file if it exists
				try {
					const backupPath = path.join(backupDir, `${i}.bak`);
					await fs.copyFile(op.path, backupPath);
					jop.backupPath = backupPath;
				} catch {
					// File doesn't exist yet — no backup needed
				}
				jop.content = Buffer.from(op.content).toString('base64');
				jop.contentChecksum = sha256Hex(typeof op.content === 'string' ? op.content : new TextDecoder().decode(op.content));
			} else if (op.type === 'delete') {
				// Backup file before delete
				try {
					const backupPath = path.join(backupDir, `${i}.bak`);
					await fs.copyFile(op.path, backupPath);
					jop.backupPath = backupPath;
				} catch {
					// Already gone — no-op
				}
			}

			journalOps.push(jop);
		}

		return journalOps;
	}

	private _enqueueBatched(operations: FileOperation[]): Promise<void> {
		return new Promise((resolve, reject) => {
			this._batchQueue.push({ ops: operations, resolve, reject });
			if (!this._batchTimer) {
				this._batchTimer = setTimeout(() => this._flushBatch(), this._batchWindowMs);
			}
		});
	}

	private async _flushBatch(): Promise<void> {
		this._batchTimer = null;
		const batch = this._batchQueue.splice(0);
		if (batch.length === 0) {
			return;
		}

		const allOps = batch.flatMap(b => b.ops);
		try {
			await this._executeTransaction(allOps);
			for (const b of batch) {
				b.resolve();
			}
		} catch (e) {
			for (const b of batch) {
				b.reject(e as Error);
			}
		}
	}

	// -- Private Static Helpers ------------------------------------------------

	private static _computeChecksum(ops: JournalOperation[]): string {
		const data = JSON.stringify(ops);
		return sha256Hex(data);
	}

	private static async _executeOp(op: JournalOperation): Promise<void> {
		const fs = await requireFs();
		switch (op.type) {
			case 'write': {
				if (!op.content) {
					throw new Error('QIC-J003: Write operation missing content');
				}
				const buf = Buffer.from(op.content, 'base64');
				await fs.mkdir(path.dirname(op.targetPath), { recursive: true });
				// Write via file handle + fdatasync to ensure durability before journal deletion
				const fh = await fs.open(op.targetPath, 'w');
				await fh.writeFile(buf);
				await fh.datasync();
				await fh.close();
				break;
			}
			case 'rename': {
				if (!op.backupPath) {
					throw new Error('QIC-J003: Rename operation missing source path');
				}
				await fs.rename(op.backupPath, op.targetPath);
				break;
			}
			case 'delete': {
				await fs.unlink(op.targetPath).catch(() => { });
				break;
			}
		}
	}

	private static async _rollbackOp(op: JournalOperation): Promise<void> {
		const fs = await requireFs();
		if (op.backupPath) {
			try {
				await fs.copyFile(op.backupPath, op.targetPath);
			} catch {
				// QIC-J004: Best effort rollback
			}
		} else if (op.type === 'write') {
			// No backup means file didn't exist before — delete the new file
			await fs.unlink(op.targetPath).catch(() => { });
		}
	}

	private static async _checkOperationStatuses(ops: JournalOperation[]): Promise<Array<'completed' | 'pending'>> {
		const fs = await requireFs();
		const statuses: Array<'completed' | 'pending'> = [];
		for (const op of ops) {
			switch (op.type) {
				case 'write': {
					try {
						await fs.access(op.targetPath);
						// Verify content matches if we have a checksum
						if (op.contentChecksum) {
							const existing = await fs.readFile(op.targetPath, 'utf-8');
							const hash = sha256Hex(existing);
							statuses.push(hash === op.contentChecksum ? 'completed' : 'pending');
						} else {
							statuses.push('completed');
						}
					} catch {
						statuses.push('pending');
					}
					break;
				}
				case 'delete': {
					try {
						await fs.access(op.targetPath);
						statuses.push('pending'); // File still exists — delete not done
					} catch {
						statuses.push('completed'); // File gone — delete succeeded
					}
					break;
				}
				default:
					statuses.push('pending');
			}
		}
		return statuses;
	}

	private static async _quarantine(journalDir: string, journalPath: string, reason: string): Promise<void> {
		const fs = await requireFs();
		const quarantineDir = path.join(journalDir, QUARANTINE_DIR);
		await fs.mkdir(quarantineDir, { recursive: true });
		const dest = path.join(quarantineDir, path.basename(journalPath));
		await fs.rename(journalPath, dest);
		// Write reason file
		await fs.writeFile(dest + '.reason', reason, 'utf-8');
	}
}
