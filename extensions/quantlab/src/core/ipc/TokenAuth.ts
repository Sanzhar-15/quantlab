/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Token-based authentication for daemon communication.
 *
 * Reads authentication token from ~/.quantlab/sessions/{id}.token
 * and attaches it to JSON-RPC requests.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { JsonRpcRequest } from './types';

/**
 * Token file metadata.
 */
export interface TokenInfo {
	token: string;
	sessionId: string;
	createdAt: number;
	expiresAt?: number;
}

/**
 * Token authentication manager.
 */
export class TokenAuth {
	private readonly sessionId: string;
	private readonly tokenPath: string;
	private cachedToken: string | null = null;
	private lastRead: number = 0;
	private readonly cacheTtlMs: number;

	constructor(sessionId: string, cacheTtlMs: number = 5000) {
		this.sessionId = sessionId;
		this.cacheTtlMs = cacheTtlMs;
		this.tokenPath = this.getTokenPath(sessionId);
	}

	/**
	 * Get the token file path for a session.
	 */
	private getTokenPath(sessionId: string): string {
		return path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.token`);
	}

	/**
	 * Get the authentication token.
	 *
	 * Reads from file with caching to avoid excessive filesystem access.
	 */
	async getToken(): Promise<string> {
		const now = Date.now();

		// Return cached token if still valid
		if (this.cachedToken && (now - this.lastRead) < this.cacheTtlMs) {
			return this.cachedToken;
		}

		try {
			const content = await fs.readFile(this.tokenPath, 'utf-8');
			const token = content.trim();

			if (!token) {
				throw new Error('Token file is empty');
			}

			this.cachedToken = token;
			this.lastRead = now;

			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				throw new Error(`Token file not found: ${this.tokenPath}`);
			}
			throw error;
		}
	}

	/**
	 * Check if a valid token exists.
	 */
	async hasToken(): Promise<boolean> {
		try {
			await this.getToken();
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Authenticate a JSON-RPC request by adding auth headers.
	 *
	 * Adds the token to the request params.
	 */
	async authenticate(request: JsonRpcRequest): Promise<JsonRpcRequest> {
		const token = await this.getToken();

		// Clone the request and add auth
		const params = request.params ?? {};
		const authParams = typeof params === 'object' && params !== null
			? { ...params, _auth: { token, sessionId: this.sessionId } }
			: { value: params, _auth: { token, sessionId: this.sessionId } };

		return {
			...request,
			params: authParams,
		};
	}

	/**
	 * Clear the token cache.
	 */
	clearCache(): void {
		this.cachedToken = null;
		this.lastRead = 0;
	}

	/**
	 * Get the session ID.
	 */
	getSessionId(): string {
		return this.sessionId;
	}
}

/**
 * Generate a secure random token.
 */
export function generateToken(length: number = 32): string {
	return crypto.randomBytes(length).toString('hex');
}

/**
 * Write a token file for a session.
 */
export async function writeTokenFile(sessionId: string, token: string): Promise<void> {
	const dir = path.join(os.homedir(), '.quantlab', 'sessions');
	const tokenPath = path.join(dir, `${sessionId}.token`);

	// Ensure directory exists
	await fs.mkdir(dir, { recursive: true });

	// Write with secure permissions (owner read/write only)
	await fs.writeFile(tokenPath, token, { mode: 0o600 });
}

/**
 * Delete a token file for a session.
 */
export async function deleteTokenFile(sessionId: string): Promise<void> {
	const tokenPath = path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.token`);

	try {
		await fs.unlink(tokenPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
			throw error;
		}
	}
}

/**
 * Read and parse token info from file.
 */
export async function readTokenInfo(sessionId: string): Promise<TokenInfo | null> {
	const tokenPath = path.join(os.homedir(), '.quantlab', 'sessions', `${sessionId}.token`);

	try {
		const content = await fs.readFile(tokenPath, 'utf-8');
		const token = content.trim();

		if (!token) {
			return null;
		}

		// Get file stats for creation time
		const stats = await fs.stat(tokenPath);

		return {
			token,
			sessionId,
			createdAt: stats.ctimeMs,
		};
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			return null;
		}
		throw error;
	}
}

/**
 * Validate a token against expected value.
 */
export function validateToken(provided: string, expected: string): boolean {
	// Use timing-safe comparison to prevent timing attacks
	if (provided.length !== expected.length) {
		return false;
	}

	const providedBuf = Buffer.from(provided);
	const expectedBuf = Buffer.from(expected);

	return crypto.timingSafeEqual(providedBuf, expectedBuf);
}

/**
 * Extract auth info from request params.
 */
export function extractAuth(params: unknown): { token: string; sessionId: string } | null {
	if (typeof params !== 'object' || params === null) {
		return null;
	}

	const p = params as Record<string, unknown>;
	const auth = p._auth;

	if (typeof auth !== 'object' || auth === null) {
		return null;
	}

	const a = auth as Record<string, unknown>;

	if (typeof a.token !== 'string' || typeof a.sessionId !== 'string') {
		return null;
	}

	return {
		token: a.token,
		sessionId: a.sessionId,
	};
}
