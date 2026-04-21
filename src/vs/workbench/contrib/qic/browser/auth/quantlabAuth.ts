/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomUUID, sha256Hex } from '../../common/qicCrypto.js';
import { QicError } from '../../common/canonical/types.js';

// PKCE charset: unreserved characters per RFC 7636
const PKCE_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';

export interface AuthTokens {
	accessToken: string;
	refreshToken: string;
	expiresIn: number;
	scope: string;
}

export interface QuantlabAuthConfig {
	authorizeUrl: string;   // e.g., 'https://accounts.quantlab.dev/authorize'
	tokenUrl: string;       // e.g., 'https://accounts.quantlab.dev/token'
	clientId: string;       // e.g., 'qic-vscode'
	redirectUri: string;    // e.g., 'vscode://quantlab.qic/auth/callback'
	scopes: string[];       // e.g., ['openid', 'profile', 'email', 'offline_access']
	audience?: string;      // e.g., 'https://api.quantlab.dev'
}

/**
 * OAuth2 PKCE authentication for Quantlab Cloud.
 * Manages the authorization flow: PKCE generation -> browser open -> code exchange.
 */
export class QuantlabAuth {
	private readonly config: QuantlabAuthConfig;
	private pendingVerifier: string | null = null;
	private pendingState: string | null = null;

	constructor(config: QuantlabAuthConfig) {
		this.config = config;
	}

	/**
	 * Generate the authorization URL and PKCE verifier.
	 * Caller opens this URL in the system browser.
	 */
	async startAuthFlow(): Promise<{ authUrl: string; state: string }> {
		// Generate PKCE code verifier (43-128 chars)
		const verifier = this.generateCodeVerifier(64);
		const challenge = await this.generateCodeChallenge(verifier);
		const state = randomUUID();

		this.pendingVerifier = verifier;
		this.pendingState = state;

		const params = new URLSearchParams({
			client_id: this.config.clientId,
			redirect_uri: this.config.redirectUri,
			code_challenge: challenge,
			code_challenge_method: 'S256',
			response_type: 'code',
			scope: this.config.scopes.join(' '),
			state,
			...(this.config.audience ? { audience: this.config.audience } : {}),
		});

		return {
			authUrl: `${this.config.authorizeUrl}?${params.toString()}`,
			state,
		};
	}

	/**
	 * Exchange the authorization code for tokens.
	 * Called when the URI handler receives the callback.
	 */
	async exchangeCode(code: string, state: string): Promise<AuthTokens> {
		// Capture and clear atomically to prevent race conditions
		// (e.g., if multiple callbacks arrive or auth is restarted)
		const verifier = this.pendingVerifier;
		const pendingState = this.pendingState;
		this.clearPending();

		if (!verifier || !pendingState) {
			throw new QicError('QIC-A001', 'No pending authentication flow');
		}

		if (state !== pendingState) {
			throw new QicError('QIC-A002', 'Authentication state mismatch — possible CSRF attack');
		}

		const response = await fetch(this.config.tokenUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'authorization_code',
				code,
				code_verifier: verifier,
				client_id: this.config.clientId,
				redirect_uri: this.config.redirectUri,
			}).toString(),
		});

		if (!response.ok) {
			const errorText = await response.text().catch(() => 'Unknown error');
			throw new QicError('QIC-A003', `Token exchange failed: ${response.status}`, errorText, response.status);
		}

		const data = await response.json() as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
			scope: string;
		};

		return {
			accessToken: data.access_token,
			refreshToken: data.refresh_token,
			expiresIn: data.expires_in,
			scope: data.scope,
		};
	}

	/**
	 * Revoke tokens on sign-out.
	 */
	async revokeTokens(accessToken: string, refreshToken: string): Promise<void> {
		try {
			await fetch(`${this.getBaseUrl()}/v1/auth/revoke`, {
				method: 'POST',
				headers: {
					'Authorization': `Bearer ${accessToken}`,
					'Content-Type': 'application/x-www-form-urlencoded',
				},
				body: new URLSearchParams({
					token: refreshToken,
					client_id: this.config.clientId,
					token_type_hint: 'refresh_token',
				}).toString(),
			});
		} catch {
			// Best-effort — if revocation fails, tokens will expire naturally
		}
	}

	private clearPending(): void {
		this.pendingVerifier = null;
		this.pendingState = null;
	}

	private getBaseUrl(): string {
		const url = new URL(this.config.tokenUrl);
		return `${url.protocol}//${url.host}`;
	}

	private generateCodeVerifier(length: number): string {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return Array.from(array, byte => PKCE_CHARSET[byte % PKCE_CHARSET.length]).join('');
	}

	private async generateCodeChallenge(verifier: string): Promise<string> {
		// S256: BASE64URL(SHA256(code_verifier))
		const hash = sha256Hex(verifier);
		// Convert hex to bytes, then base64url encode
		const bytes = new Uint8Array(hash.match(/.{2}/g)!.map(h => parseInt(h, 16)));
		const base64 = btoa(String.fromCharCode(...bytes));
		return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}
}
