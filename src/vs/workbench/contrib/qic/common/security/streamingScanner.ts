/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { OptimizedSecretScanner } from './secretScanner.js';

/**
 * Streaming secret scanner for large files. Processes chunks without
 * loading the entire file into memory.
 */
export class StreamingSecretScanner {
	private buffer = '';
	private readonly overlapSize = 300; // Handle patterns spanning chunk boundaries
	private readonly scanner: OptimizedSecretScanner;

	constructor(scanner: OptimizedSecretScanner) {
		this.scanner = scanner;
	}

	processChunk(chunk: string): string {
		this.buffer += chunk;

		if (this.buffer.length <= this.overlapSize) {
			return '';
		}

		// Process everything except the overlap region at the end
		const processLength = this.buffer.length - this.overlapSize;
		const toProcess = this.buffer.slice(0, processLength);
		const result = this.scanner.scan(toProcess);

		// Keep the overlap for cross-boundary pattern matching
		this.buffer = this.buffer.slice(processLength);

		return result.redactedText;
	}

	flush(): string {
		if (this.buffer.length === 0) {
			return '';
		}
		const result = this.scanner.scan(this.buffer);
		this.buffer = '';
		return result.redactedText;
	}
}
