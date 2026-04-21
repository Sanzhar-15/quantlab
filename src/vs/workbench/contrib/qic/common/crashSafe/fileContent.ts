/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

async function lazyCreateReadStream(filePath: string, opts?: { highWaterMark?: number }): Promise<import('fs').ReadStream> {
	const { createReadStream } = await import('fs');
	return createReadStream(filePath, opts);
}

// ---------------------------------------------------------------------------
// FileContent Discriminated Union
// ---------------------------------------------------------------------------

/**
 * Tiered file content representation.
 *
 *   inline    : < 1 MB   — full content as string
 *   stream    : 1–50 MB  — async iterable of chunks
 *   reference : 50–100 MB — path + SHA-256 hash (for checkpoints)
 *   rejected  : > 100 MB — too large, user is notified
 */
export type FileContent =
	| { type: 'inline'; data: string; sizeBytes: number }
	| { type: 'stream'; handle: AsyncIterable<Uint8Array>; sizeBytes: number }
	| { type: 'reference'; path: string; hash: string }
	| { type: 'rejected'; path: string; sizeBytes: number; maxAllowed: number };

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface FileHandlingConfig {
	inlineThreshold: number;      // Files below this are inline (default 1 MB)
	streamThreshold: number;      // Files below this are streamed (default 50 MB)
	referenceThreshold: number;   // Files below this are reference-only (default 100 MB)
	chunkSize: number;            // Chunk size for stream reads (default 64 KB)
}

export const DEFAULT_FILE_HANDLING_CONFIG: FileHandlingConfig = {
	inlineThreshold: 1 * 1024 * 1024,
	streamThreshold: 50 * 1024 * 1024,
	referenceThreshold: 100 * 1024 * 1024,
	chunkSize: 64 * 1024,
};

// ---------------------------------------------------------------------------
// FileContentLoader
// ---------------------------------------------------------------------------

export class FileContentLoader {

	constructor(
		private readonly config: FileHandlingConfig = DEFAULT_FILE_HANDLING_CONFIG,
	) {}

	/**
	 * Load a file as the appropriate FileContent variant based on its size.
	 */
	async loadFile(filePath: string): Promise<FileContent> {
		const fs = await fsPromises();
		const stat = await fs.stat(filePath);
		const size = stat.size;

		if (size >= this.config.referenceThreshold) {
			return { type: 'rejected', path: filePath, sizeBytes: size, maxAllowed: this.config.referenceThreshold };
		}

		if (size >= this.config.streamThreshold) {
			const hash = await this._computeHash(filePath);
			return { type: 'reference', path: filePath, hash };
		}

		if (size >= this.config.inlineThreshold) {
			const handle = this._createStream(filePath);
			return { type: 'stream', handle, sizeBytes: size };
		}

		const data = await fs.readFile(filePath, 'utf-8');
		return { type: 'inline', data, sizeBytes: size };
	}

	/**
	 * Convert any FileContent to a full string.
	 * Only works for inline; streams are consumed; reference/rejected throw.
	 */
	async toFullString(content: FileContent): Promise<string> {
		switch (content.type) {
			case 'inline':
				return content.data;
			case 'stream': {
				const chunks: Buffer[] = [];
				for await (const chunk of content.handle) {
					chunks.push(Buffer.from(chunk));
				}
				return Buffer.concat(chunks).toString('utf-8');
			}
			case 'reference':
				throw new Error(`Cannot read reference file fully (${content.path}). Use stream-based processing.`);
			case 'rejected':
				throw new Error(`File rejected: ${content.path} is ${content.sizeBytes} bytes (max ${content.maxAllowed}).`);
		}
	}

	/**
	 * Process FileContent with variant-specific handlers.
	 */
	async processContent<T>(
		content: FileContent,
		handlers: {
			onInline: (data: string, sizeBytes: number) => T | Promise<T>;
			onStream: (handle: AsyncIterable<Uint8Array>, sizeBytes: number) => T | Promise<T>;
			onReference: (filePath: string, hash: string) => T | Promise<T>;
			onRejected: (filePath: string, sizeBytes: number, maxAllowed: number) => T | Promise<T>;
		},
	): Promise<T> {
		switch (content.type) {
			case 'inline':
				return handlers.onInline(content.data, content.sizeBytes);
			case 'stream':
				return handlers.onStream(content.handle, content.sizeBytes);
			case 'reference':
				return handlers.onReference(content.path, content.hash);
			case 'rejected':
				return handlers.onRejected(content.path, content.sizeBytes, content.maxAllowed);
		}
	}

	// -- Private helpers -------------------------------------------------------

	private _createStream(filePath: string): AsyncIterable<Uint8Array> {
		const chunkSize = this.config.chunkSize;
		let stream: import('fs').ReadStream | undefined;
		return {
			[Symbol.asyncIterator]() {
				return {
					async next() {
						if (!stream) {
							stream = await lazyCreateReadStream(filePath, { highWaterMark: chunkSize });
						}
						const iterator = stream[Symbol.asyncIterator]();
						// Replace next to use the real iterator from now on
						this.next = async () => {
							const result = await iterator.next();
							return result as IteratorResult<Uint8Array>;
						};
						const result = await iterator.next();
						return result as IteratorResult<Uint8Array>;
					},
					async return() {
						stream?.destroy();
						return { done: true as const, value: undefined };
					},
					async throw(err: Error) {
						stream?.destroy(err);
						return { done: true as const, value: undefined };
					},
				};
			},
		};
	}

	private async _computeHash(filePath: string): Promise<string> {
		const fs = await fsPromises();
		const content = await fs.readFile(filePath, 'utf-8');
		return sha256Hex(content);
	}
}

// ---------------------------------------------------------------------------
// Streaming Secret Scanner Transform
// ---------------------------------------------------------------------------

/**
 * Create a transform that redacts secrets from streaming text content.
 */
export function createRedactingTransform(
	scanner: { scanChunk(text: string): string },
): TransformStream<string, string> {
	return new TransformStream({
		transform(chunk, controller) {
			controller.enqueue(scanner.scanChunk(chunk));
		},
	});
}
