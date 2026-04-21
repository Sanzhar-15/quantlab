/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { QicError } from '../canonical/types.js';

export interface SearchResult {
	filePath: string;
	content: string;
	score: number;
	source: 'bm25' | 'vector' | 'hybrid';
	lineRange?: { start: number; end: number };
}

/**
 * LanceDB vector storage with code_embeddings and doc_embeddings tables (Audit VII-DS9).
 * Uses dynamic import for LanceDB to gracefully handle unavailability.
 */
export class VectorIndex {
	private db: any = null;
	private initialized = false;

	async initialize(storagePath: string): Promise<void> {
		try {
			// @ts-ignore - lancedb is an optional runtime dependency
			const lancedb = await import('lancedb');
			this.db = await lancedb.connect(storagePath);

			// Create tables if not exist
			await this.ensureTable('code_embeddings', {
				vector: new Float32Array(768),
				path: '',
				chunk: '',
				line_start: 0,
				line_end: 0,
			});

			await this.ensureTable('doc_embeddings', {
				vector: new Float32Array(768),
				path: '',
				content: '',
				type: '',
			});

			this.initialized = true;
		} catch (e) {
			this.db = null;
			this.initialized = false;
			throw e;
		}
	}

	get isInitialized(): boolean {
		return this.initialized;
	}

	async search(query: Float32Array, table: string, limit: number): Promise<SearchResult[]> {
		if (!this.db) {
			throw new QicError('QIC-C003', 'Vector index not initialized');
		}

		try {
			const tbl = await this.db.openTable(table);
			const results = await tbl.search(query).limit(limit).execute();

			return results.map((row: any) => ({
				filePath: row.path,
				content: row.chunk ?? row.content ?? '',
				score: row._distance ? 1 / (1 + row._distance) : 0,
				source: 'vector' as const,
				lineRange: row.line_start !== undefined
					? { start: row.line_start, end: row.line_end }
					: undefined,
			}));
		} catch {
			return [];
		}
	}

	async addCodeEmbedding(
		embedding: Float32Array,
		path: string,
		chunk: string,
		lineStart: number,
		lineEnd: number,
	): Promise<void> {
		if (!this.db) { return; }
		const tbl = await this.db.openTable('code_embeddings');
		await tbl.add([{ vector: embedding, path, chunk, line_start: lineStart, line_end: lineEnd }]);
	}

	async addDocEmbedding(
		embedding: Float32Array,
		path: string,
		content: string,
		type: string,
	): Promise<void> {
		if (!this.db) { return; }
		const tbl = await this.db.openTable('doc_embeddings');
		await tbl.add([{ vector: embedding, path, content, type }]);
	}

	async removeByPath(filePath: string): Promise<void> {
		if (!this.db) { return; }
		try {
			// Escape single quotes in filePath to prevent injection (AUDIT FIX: SQL injection)
			const escaped = filePath.replace(/'/g, "''");
			const codeTbl = await this.db.openTable('code_embeddings');
			await codeTbl.delete(`path = '${escaped}'`);
			const docTbl = await this.db.openTable('doc_embeddings');
			await docTbl.delete(`path = '${escaped}'`);
		} catch {
			// Best effort
		}
	}

	dispose(): void {
		this.db = null;
		this.initialized = false;
	}

	private async ensureTable(name: string, schema: Record<string, any>): Promise<void> {
		try {
			await this.db.openTable(name);
		} catch {
			await this.db.createTable(name, [schema]);
		}
	}
}
