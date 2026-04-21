/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { EditScript } from '../canonical/types.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

export interface ConflictResult {
	hasConflicts: boolean;
	conflicts: FileConflict[];
}

export interface FileConflict {
	path: string;
	type: 'modified' | 'deleted' | 'created';
	originalHash: string;
	currentHash: string;
}

export class ConflictDetector {

	async detectConflicts(
		editScript: EditScript,
		originalHashes: Map<string, string>,
	): Promise<ConflictResult> {
		const fs = await fsPromises();
		const conflicts: FileConflict[] = [];

		for (const fileEdit of editScript.edits) {
			const originalHash = originalHashes.get(fileEdit.path);
			let currentHash: string;
			let fileExists: boolean;

			try {
				const content = await fs.readFile(fileEdit.path, 'utf8');
				currentHash = sha256Hex(content);
				fileExists = true;
			} catch {
				currentHash = '';
				fileExists = false;
			}

			if (!originalHash && fileExists) {
				// File was created since EditScript was generated
				conflicts.push({
					path: fileEdit.path,
					type: 'created',
					originalHash: '',
					currentHash,
				});
			} else if (originalHash && !fileExists) {
				// File was deleted since EditScript was generated
				conflicts.push({
					path: fileEdit.path,
					type: 'deleted',
					originalHash,
					currentHash: '',
				});
			} else if (originalHash && currentHash && originalHash !== currentHash) {
				// File was modified since EditScript was generated
				conflicts.push({
					path: fileEdit.path,
					type: 'modified',
					originalHash,
					currentHash,
				});
			}
		}

		return {
			hasConflicts: conflicts.length > 0,
			conflicts,
		};
	}

	async hashFile(filePath: string): Promise<string> {
		const fs = await fsPromises();
		const content = await fs.readFile(filePath, 'utf8');
		return sha256Hex(content);
	}

	async hashFiles(filePaths: string[]): Promise<Map<string, string>> {
		const hashes = new Map<string, string>();
		for (const filePath of filePaths) {
			try {
				hashes.set(filePath, await this.hashFile(filePath));
			} catch {
				// File doesn't exist — skip
			}
		}
		return hashes;
	}
}
