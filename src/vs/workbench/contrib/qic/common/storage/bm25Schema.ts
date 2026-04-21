/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * BM25 full-text search schema (Audit S-7 / I-SG11).
 * Includes document metadata, term frequencies, posting lists,
 * and an FTS5 virtual table with porter stemming.
 */
export const BM25_SCHEMA = `
-- Document metadata
CREATE TABLE IF NOT EXISTS qic_bm25_docs (
	doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
	file_path TEXT NOT NULL UNIQUE,
	content_hash TEXT NOT NULL,
	word_count INTEGER NOT NULL,
	last_indexed TEXT NOT NULL
);

-- Term frequency table
CREATE TABLE IF NOT EXISTS qic_bm25_terms (
	term_id INTEGER PRIMARY KEY AUTOINCREMENT,
	term TEXT NOT NULL UNIQUE,
	doc_frequency INTEGER NOT NULL DEFAULT 0
);

-- Posting list (term-to-document occurrences)
CREATE TABLE IF NOT EXISTS qic_bm25_postings (
	term_id INTEGER NOT NULL,
	doc_id INTEGER NOT NULL,
	term_frequency INTEGER NOT NULL,
	positions TEXT,
	PRIMARY KEY (term_id, doc_id),
	FOREIGN KEY (term_id) REFERENCES qic_bm25_terms(term_id),
	FOREIGN KEY (doc_id) REFERENCES qic_bm25_docs(doc_id)
);

-- FTS5 virtual table for full-text search (Audit I-SG11)
CREATE VIRTUAL TABLE IF NOT EXISTS qic_bm25_fts5 USING fts5(
	content, path,
	content='qic_bm25_docs',
	content_rowid='doc_id',
	tokenize='porter unicode61'
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_qic_bm25_postings_doc ON qic_bm25_postings(doc_id);
CREATE INDEX IF NOT EXISTS idx_qic_bm25_docs_path ON qic_bm25_docs(file_path);
CREATE INDEX IF NOT EXISTS idx_qic_bm25_terms_term ON qic_bm25_terms(term);
CREATE INDEX IF NOT EXISTS idx_qic_bm25_docs_hash ON qic_bm25_docs(content_hash);
`;
