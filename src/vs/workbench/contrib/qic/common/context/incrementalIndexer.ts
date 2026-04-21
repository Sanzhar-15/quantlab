/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QicDatabase } from '../storage/database.js';
import type { SecureEmbeddingService } from './secureEmbedding.js';
import { VectorIndex, SearchResult } from './vectorIndex.js';
import { RRFReranker } from './reranker.js';

export interface SearchOptions {
	maxResults?: number;
	fileFilter?: string;
	includeVector?: boolean;
}

export interface IndexResult {
	filesIndexed: number;
	errors: string[];
	vectorAvailable: boolean;
}

// BM25 constants
const BM25_K1 = 1.2;
const BM25_B = 0.75;

/**
 * BM25 + vector hybrid indexer (Audit IX-CC5).
 * Uses IFileService.onDidFilesChange for incremental updates.
 */
export class IncrementalIndexer {
	private vectorIndex: VectorIndex | null = null;
	private readonly reranker = new RRFReranker();
	private avgDocLength = 0;
	private totalDocs = 0;

	constructor(
		private readonly db: QicDatabase,
		private readonly embeddingService: SecureEmbeddingService,
	) {}

	async indexWorkspace(workspacePath: string): Promise<IndexResult> {
		const errors: string[] = [];

		// Phase 1: Vector search disabled — SecureEmbeddingService sends chat
		// completions instead of the embeddings endpoint, producing zero vectors.
		// BM25-only until the embedding API format is corrected.
		const vectorAvailable = false;
		this.vectorIndex = null;

		// BM25 indexing proceeds regardless
		let filesIndexed = 0;
		try {
			const row = this.db.get<{ count: number }>('SELECT COUNT(*) as count FROM qic_bm25_docs');
			filesIndexed = row?.count ?? 0;
			this.totalDocs = filesIndexed;
		} catch {
			// Tables may not exist yet
		}

		return { filesIndexed, errors, vectorAvailable };
	}

	async updateFile(filePath: string, changeType: 'modified' | 'created' | 'deleted'): Promise<void> {
		if (changeType === 'deleted') {
			this.removeFromBM25(filePath);
			if (this.vectorIndex) {
				await this.vectorIndex.removeByPath(filePath);
			}
		} else {
			await this.indexFile(filePath);
		}
	}

	async search(query: string, options?: SearchOptions): Promise<SearchResult[]> {
		const maxResults = options?.maxResults ?? 20;

		// BM25 search
		const bm25Results = this.searchBM25(query, maxResults);

		// Populate file content for BM25 results
		await this.populateContent(bm25Results);

		// Vector search (if available)
		if (!this.vectorIndex || !options?.includeVector) {
			return bm25Results;
		}

		try {
			const embeddings = await this.embeddingService.embed([query]);
			const vectorResults = await this.vectorIndex.search(embeddings[0], 'code_embeddings', maxResults);

			return this.reranker.rerank([
				{ results: bm25Results, weight: 0.4, name: 'bm25' },
				{ results: vectorResults, weight: 0.4, name: 'vector' },
			], maxResults);
		} catch {
			return bm25Results;
		}
	}

	private searchBM25(query: string, maxResults: number): SearchResult[] {
		const terms = this.tokenize(query);
		if (terms.length === 0) { return []; }

		try {
			const results = new Map<number, { score: number; path: string; content: string }>();

			for (const term of terms) {
				const termRow = this.db.get<{ term_id: number; doc_frequency: number }>('SELECT term_id, doc_frequency FROM qic_bm25_terms WHERE term = ?', term);
				if (!termRow) { continue; }

				const idf = Math.log((this.totalDocs - termRow.doc_frequency + 0.5) / (termRow.doc_frequency + 0.5) + 1);

				const postings = this.db.all<{ doc_id: number; term_frequency: number; file_path: string; word_count: number }>(
					'SELECT p.doc_id, p.term_frequency, d.file_path, d.word_count FROM qic_bm25_postings p JOIN qic_bm25_docs d ON p.doc_id = d.doc_id WHERE p.term_id = ?',
					termRow.term_id
				);

				for (const posting of postings) {
					const tf = posting.term_frequency;
					const dl = posting.word_count;
					const avgdl = this.avgDocLength || 100;
					const score = idf * (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * dl / avgdl));

					const existing = results.get(posting.doc_id);
					if (existing) {
						existing.score += score;
					} else {
						results.set(posting.doc_id, {
							score,
							path: posting.file_path,
							content: '',
						});
					}
				}
			}

			return [...results.values()]
				.sort((a, b) => b.score - a.score)
				.slice(0, maxResults)
				.map(r => ({
					filePath: r.path,
					content: r.content,
					score: r.score,
					source: 'bm25' as const,
				}));
		} catch {
			return [];
		}
	}

	private async populateContent(results: SearchResult[]): Promise<void> {
		try {
			// @ts-ignore - dynamic import for sandboxed renderer fallback
			const fs = await import('fs/promises');
			for (const result of results) {
				try {
					const content = await fs.readFile(result.filePath, 'utf8');
					result.content = content.slice(0, 2000);
				} catch {
					// File unreadable — leave content empty
				}
			}
		} catch {
			// fs not available in browser
		}
	}

	private async indexFile(filePath: string): Promise<void> {
		let content: string;
		try {
			// @ts-ignore - dynamic import for sandboxed renderer fallback
			const fs = await import('fs/promises');
			content = await fs.readFile(filePath, 'utf8');
		} catch {
			return; // File unreadable — skip silently
		}

		const contentHash = this.simpleHash(content);
		const tokens = this.tokenize(content);
		const wordCount = tokens.length;

		if (wordCount === 0) { return; }

		// Check if already indexed with same hash (skip re-indexing)
		const existing = this.db.get<{ doc_id: number; content_hash: string }>(
			'SELECT doc_id, content_hash FROM qic_bm25_docs WHERE file_path = ?', filePath
		);

		if (existing && existing.content_hash === contentHash) {
			return; // Content unchanged — no re-index needed
		}

		// Remove stale data if file was previously indexed
		if (existing) {
			this.removeFromBM25(filePath);
		}

		// Wrap all BM25 mutations in a transaction for consistency
		this.db.transaction(() => {
			// Insert document record
			const now = new Date().toISOString();
			this.db.run(
				'INSERT INTO qic_bm25_docs (file_path, content_hash, word_count, last_indexed) VALUES (?, ?, ?, ?)',
				filePath, contentHash, wordCount, now
			);

			const docRow = this.db.get<{ doc_id: number }>('SELECT doc_id FROM qic_bm25_docs WHERE file_path = ?', filePath);
			if (!docRow) { return; }

			const docId = docRow.doc_id;

			// Build term frequencies for this document
			const termFreqs = new Map<string, number>();
			for (const token of tokens) {
				termFreqs.set(token, (termFreqs.get(token) ?? 0) + 1);
			}

			// Upsert terms and postings
			for (const [term, tf] of termFreqs) {
				// Upsert term into terms table
				this.db.run(
					'INSERT INTO qic_bm25_terms (term, doc_frequency) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET doc_frequency = doc_frequency + 1',
					term
				);

				const termRow = this.db.get<{ term_id: number }>('SELECT term_id FROM qic_bm25_terms WHERE term = ?', term);
				if (!termRow) { continue; }

				// Insert posting
				this.db.run(
					'INSERT INTO qic_bm25_postings (term_id, doc_id, term_frequency) VALUES (?, ?, ?)',
					termRow.term_id, docId, tf
				);
			}
		});

		// Update running statistics (outside transaction — these are in-memory estimates)
		this.totalDocs++;
		this.avgDocLength = ((this.avgDocLength * (this.totalDocs - 1)) + wordCount) / this.totalDocs;

		// Vector indexing (if available)
		if (this.vectorIndex) {
			try {
				const embeddings = await this.embeddingService.embed([content.slice(0, 8000)]);
				const ext = filePath.split('.').pop() ?? '';
				const isCode = ['ts', 'js', 'py', 'rs', 'go', 'java', 'cpp', 'c', 'cs'].includes(ext);
				if (isCode) {
					await this.vectorIndex.addCodeEmbedding(embeddings[0], filePath, content.slice(0, 2000), 1, content.split('\n').length);
				} else {
					await this.vectorIndex.addDocEmbedding(embeddings[0], filePath, content.slice(0, 2000), ext);
				}
			} catch {
				// Vector embedding failed — BM25 index still valid
			}
		}
	}

	private simpleHash(content: string): string {
		// Simple djb2 hash for content change detection
		let hash = 5381;
		for (let i = 0; i < content.length; i++) {
			hash = ((hash << 5) + hash) + content.charCodeAt(i);
			hash = hash & hash; // Convert to 32bit integer
		}
		return hash.toString(16);
	}

	private removeFromBM25(filePath: string): void {
		try {
			const doc = this.db.get<{ doc_id: number; word_count: number }>('SELECT doc_id, word_count FROM qic_bm25_docs WHERE file_path = ?', filePath);
			if (doc) {
				// H13: Wrap all BM25 removal operations in a transaction for consistency
				this.db.transaction(() => {
					// Decrement doc_frequency for each term this document contained
					const postings = this.db.all<{ term_id: number }>(
						'SELECT term_id FROM qic_bm25_postings WHERE doc_id = ?', doc.doc_id
					);
					for (const posting of postings) {
						this.db.run(
							'UPDATE qic_bm25_terms SET doc_frequency = MAX(0, doc_frequency - 1) WHERE term_id = ?',
							posting.term_id
						);
					}

					this.db.run('DELETE FROM qic_bm25_postings WHERE doc_id = ?', doc.doc_id);
					this.db.run('DELETE FROM qic_bm25_docs WHERE doc_id = ?', doc.doc_id);
				});

				// Update running statistics (in-memory estimates, outside transaction)
				if (this.totalDocs > 1) {
					this.avgDocLength = ((this.avgDocLength * this.totalDocs) - doc.word_count) / (this.totalDocs - 1);
					this.totalDocs--;
				} else {
					this.totalDocs = 0;
					this.avgDocLength = 0;
				}
			}
		} catch {
			// Best effort
		}
	}

	private tokenize(text: string): string[] {
		return text
			.replace(/([a-z])([A-Z])/g, '$1 $2')  // camelCase
			.replace(/[_-]/g, ' ')                   // snake_case / kebab-case
			.toLowerCase()
			.split(/\s+/)
			.filter(t => t.length > 1);
	}
}
