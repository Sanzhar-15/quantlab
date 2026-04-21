/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolResultPayload } from '../canonical/types.js';
import type { TransactionSafeCheckpointManager } from '../crashSafe/checkpointManager.js';

/**
 * Checkpoint tools (1 tool): create_checkpoint.
 * Delegates to TransactionSafeCheckpointManager for crash-safe checkpoint creation.
 */
export class CheckpointTools {

	constructor(
		private readonly checkpointManager: TransactionSafeCheckpointManager,
	) {}

	// 22. create_checkpoint
	async createCheckpoint(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const files = args.files as string[] | undefined;
			const description = args.description ? String(args.description) : undefined;

			if (!files || !Array.isArray(files) || files.length === 0) {
				return { content: 'Error: files array is required and must not be empty', isError: true };
			}

			const metadata: Record<string, unknown> = {};
			if (description) {
				metadata.description = description;
			}
			if (args.label) {
				metadata.label = String(args.label);
			}

			const checkpointId = await this.checkpointManager.createCheckpoint(files, metadata);

			return {
				content: JSON.stringify({
					checkpointId,
					fileCount: files.length,
					description: description ?? '(none)',
				}),
				isError: false,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}
}
