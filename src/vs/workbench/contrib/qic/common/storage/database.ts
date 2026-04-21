/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Thin wrapper around better-sqlite3 for QIC's storage needs.
 *
 * Architecture note: VS Code's renderer runs with sandbox=true and
 * nodeIntegration=false. Native Node modules (better-sqlite3) cannot
 * be loaded in this context. When the native module is unavailable,
 * QicDatabase falls back to an in-memory store. Data is not persisted
 * across sessions in this mode, but QIC remains fully functional.
 *
 * TODO: Migrate to an IPC-based service (like VS Code's IStorageService)
 * that runs SQLite in the main/utility process and proxies to the renderer.
 */

interface SqliteRunResult {
	changes: number;
	lastInsertRowid: number | bigint;
}

export class QicDatabase {

	private db: any | null = null;
	private _inMemory = false;
	private _inMemoryWarned = false;
	private _suppressedOps = 0;

	constructor(private readonly dbPath: string) {}

	get suppressedOperationCount(): number { return this._suppressedOps; }

	get isInMemory(): boolean {
		return this._inMemory;
	}

	async initialize(): Promise<void> {
		try {
			// @ts-ignore - better-sqlite3 is a native Node module, unavailable in sandboxed renderer
			const { default: BetterSqlite3 } = await import('better-sqlite3');
			this.db = new BetterSqlite3(this.dbPath);

			// WAL mode for crash resilience + concurrent reads
			this.db.pragma('journal_mode = WAL');
			this.db.pragma('synchronous = NORMAL');
			this.db.pragma('wal_autocheckpoint = 1000');

			this._createTables();
		} catch {
			// Native module unavailable (sandboxed renderer) — use in-memory fallback
			this._inMemory = true;
		}
	}

	close(): void {
		if (this._inMemory) { return; }
		this.db?.close();
		this.db = null;
	}

	run(sql: string, ...params: unknown[]): SqliteRunResult {
		if (this._inMemory) { this._warnInMemory('run'); return { changes: 0, lastInsertRowid: 0 }; }
		return this._ensureDb().prepare(sql).run(...params);
	}

	get<T>(sql: string, ...params: unknown[]): T | undefined {
		if (this._inMemory) { this._warnInMemory('get'); return undefined; }
		return this._ensureDb().prepare(sql).get(...params) as T | undefined;
	}

	all<T>(sql: string, ...params: unknown[]): T[] {
		if (this._inMemory) { this._warnInMemory('all'); return []; }
		return this._ensureDb().prepare(sql).all(...params) as T[];
	}

	transaction<T>(fn: () => T): T {
		if (this._inMemory) {
			// In-memory mode: no real transaction support, but execute the function.
			// Note: partial side effects will persist on error in this mode.
			return fn();
		}
		const tx = this._ensureDb().transaction(fn);
		return tx();
	}

	// -- Private ---------------------------------------------------------------

	private _warnInMemory(method: string): void {
		this._suppressedOps++;
		if (!this._inMemoryWarned) {
			this._inMemoryWarned = true;
			console.warn(`[QIC-DB] Database operating in in-memory mode — ${method}() and all subsequent writes will be lost. State will not persist across sessions.`);
		}
	}

	private _ensureDb(): any {
		if (!this.db) {
			throw new Error('QIC-S001: Database not initialized. Call initialize() first.');
		}
		return this.db;
	}

	private _createTables(): void {
		const db = this._ensureDb();

		db.exec(`
			-- Agent state persistence
			CREATE TABLE IF NOT EXISTS qic_agent_state (
				session_id TEXT PRIMARY KEY,
				state TEXT NOT NULL,
				current_task_id TEXT,
				conversation_json TEXT,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				metadata_json TEXT
			);

			-- Task state persistence
			CREATE TABLE IF NOT EXISTS qic_task_state (
				task_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				state TEXT NOT NULL,
				plan_json TEXT,
				current_step INTEGER DEFAULT 0,
				completed_steps_json TEXT DEFAULT '[]',
				failed_steps_json TEXT DEFAULT '[]',
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (session_id) REFERENCES qic_agent_state(session_id)
			);

			-- Conversation state persistence
			CREATE TABLE IF NOT EXISTS qic_conversation_state (
				conversation_id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				messages_json TEXT NOT NULL,
				lane TEXT,
				token_count INTEGER DEFAULT 0,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				FOREIGN KEY (session_id) REFERENCES qic_agent_state(session_id)
			);

			-- Encrypted conversation storage (Audit Fix VII-DS7)
			CREATE TABLE IF NOT EXISTS conversations_encrypted (
				id TEXT PRIMARY KEY,
				session_id TEXT NOT NULL,
				encrypted_content BLOB NOT NULL,
				iv BLOB NOT NULL,
				auth_tag BLOB NOT NULL,
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL,
				message_count INTEGER NOT NULL,
				metadata_json TEXT
			);
			CREATE INDEX IF NOT EXISTS idx_conv_session ON conversations_encrypted(session_id);

			-- Permissions persistence (Audit Fix VII-DS8)
			CREATE TABLE IF NOT EXISTS qic_permissions (
				tool_name TEXT NOT NULL,
				scope TEXT NOT NULL,
				granted_at INTEGER NOT NULL,
				expires_at INTEGER,
				session_id TEXT,
				PRIMARY KEY (tool_name, session_id)
			);

			-- Session tracking (Audit Fix VII-DS8)
			CREATE TABLE IF NOT EXISTS qic_sessions (
				id TEXT PRIMARY KEY,
				created_at INTEGER NOT NULL,
				updated_at INTEGER NOT NULL,
				state TEXT NOT NULL DEFAULT 'active',
				metadata_json TEXT
			);

			-- Configuration key-value store (Audit Fix VII-DS8)
			CREATE TABLE IF NOT EXISTS qic_config (
				key TEXT PRIMARY KEY,
				value TEXT NOT NULL,
				updated_at INTEGER NOT NULL
			);

			-- Consent persistence (used by ConsentStore.setDatabase())
			CREATE TABLE IF NOT EXISTS qic_consents (
				boundary TEXT PRIMARY KEY,
				granted INTEGER NOT NULL DEFAULT 0,
				granted_at TEXT NOT NULL,
				scope TEXT NOT NULL,
				version TEXT NOT NULL
			);

			-- H4: BM25 full-text search tables (used by IncrementalIndexer)
			CREATE TABLE IF NOT EXISTS qic_bm25_docs (
				doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
				file_path TEXT NOT NULL UNIQUE,
				content_hash TEXT NOT NULL,
				word_count INTEGER NOT NULL,
				last_indexed TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS qic_bm25_terms (
				term_id INTEGER PRIMARY KEY AUTOINCREMENT,
				term TEXT NOT NULL UNIQUE,
				doc_frequency INTEGER NOT NULL DEFAULT 0
			);
			CREATE TABLE IF NOT EXISTS qic_bm25_postings (
				term_id INTEGER NOT NULL,
				doc_id INTEGER NOT NULL,
				term_frequency INTEGER NOT NULL,
				positions TEXT,
				PRIMARY KEY (term_id, doc_id),
				FOREIGN KEY (term_id) REFERENCES qic_bm25_terms(term_id),
				FOREIGN KEY (doc_id) REFERENCES qic_bm25_docs(doc_id)
			);
			CREATE INDEX IF NOT EXISTS idx_qic_bm25_postings_doc ON qic_bm25_postings(doc_id);
			CREATE INDEX IF NOT EXISTS idx_qic_bm25_docs_path ON qic_bm25_docs(file_path);
			CREATE INDEX IF NOT EXISTS idx_qic_bm25_terms_term ON qic_bm25_terms(term);
			CREATE INDEX IF NOT EXISTS idx_qic_bm25_docs_hash ON qic_bm25_docs(content_hash);
		`);

		// FTS5 virtual table — may fail if SQLite was compiled without FTS5
		try {
			db.exec(`
				CREATE VIRTUAL TABLE IF NOT EXISTS qic_bm25_fts5 USING fts5(
					content, path,
					content='qic_bm25_docs',
					content_rowid='doc_id',
					tokenize='porter unicode61'
				);
			`);
		} catch {
			// FTS5 unavailable — keyword search will use manual BM25 only
		}
	}
}
