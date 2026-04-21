/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Additional storage tables for permissions, sessions, and config (Audit VII-DS8).
 */
export const ADDITIONAL_STORAGE_SCHEMA = `
-- Permission grants (Audit VII-DS8)
CREATE TABLE IF NOT EXISTS qic_permissions (
	tool_name TEXT NOT NULL,
	scope TEXT NOT NULL,
	granted_at INTEGER NOT NULL,
	expires_at INTEGER,
	session_id TEXT,
	PRIMARY KEY (tool_name, session_id)
);

-- Session tracking
CREATE TABLE IF NOT EXISTS qic_sessions (
	id TEXT PRIMARY KEY,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	state TEXT NOT NULL DEFAULT 'active',
	metadata_json TEXT
);

-- Configuration key-value store
CREATE TABLE IF NOT EXISTS qic_config (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at INTEGER NOT NULL
);
`;
