/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// QuantLab -- Delta Plus Authentication Provider
// Implements vscode.AuthenticationProvider so QuantLab sessions appear in the VS Code
// account switcher and persist across restarts via the platform keychain.

import * as vscode from 'vscode';
import { ServerApiClient, ServerUser, AuthResponse } from '../core/server/ServerApiClient';
import { LoginWebviewPanel, LoginResult } from './LoginWebviewPanel';

const PROVIDER_ID = 'deltaplus';
const SESSIONS_KEY = 'deltaplus.sessions';
const MIGRATION_DONE_KEY = 'deltaplus.migrationV1Done';

// Keys written by ServerApiClient.persistTokens() -- used for migration and QIC compat.
const LEGACY_ACCESS_KEY = 'qic.deltaplusAccessToken';
const LEGACY_REFRESH_KEY = 'qic.deltaplusRefreshToken';
const LEGACY_EXPIRY_KEY = 'qic.deltaplusTokenExpiresAt';

interface StoredSession {
	id: string;
	accessToken: string;
	refreshToken: string;
	expiresAt: number;
	email: string;
	name: string;
	tier: string;
	isEmailVerified: boolean;
	avatarUrl?: string;
}

export class DeltaPlusAuthProvider implements vscode.AuthenticationProvider, vscode.Disposable {
	private readonly _sessionChangeEmitter =
		new vscode.EventEmitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._sessionChangeEmitter.event;

	private readonly _disposables: vscode.Disposable[] = [];
	private _sessions: StoredSession[] = [];
	private _sessionsLoaded = false;
	private _sessionsLoadingPromise: Promise<void> | null = null;
	private _loginInProgress = false; // guards against concurrent createSession() calls opening two panels

	constructor(
		private readonly _context: vscode.ExtensionContext,
		private readonly _serverClient: ServerApiClient
	) {
		// Watch for token refreshes from ServerApiClient and sync back to storage.
		// Also purge stale sessions when the refresh token expires (onAuthStateChange(false)).
		this._disposables.push(
			_serverClient.onAuthStateChange(authenticated => {
				if (authenticated) {
					void this._syncTokensFromClient();
				} else {
					// Refresh token invalid / expired -- remove the stale session from
					// SecretStorage so the auth gate detects the cleared state and
					// re-shows the sign-in screen.
					void this._purgeExpiredSession();
				}
			})
		);

		// Watch for external SecretStorage changes (e.g. another window signed in).
		this._disposables.push(
			_context.secrets.onDidChange(e => {
				if (e.key === SESSIONS_KEY) {
					void this._handleExternalSessionChange();
				}
			})
		);
	}

	// -- vscode.AuthenticationProvider ------------------------------------------

	async getSessions(
		_scopes?: readonly string[],
		_options?: vscode.AuthenticationProviderSessionOptions
	): Promise<vscode.AuthenticationSession[]> {
		await this._ensureSessionsLoaded();
		return this._sessions.map(s => this._toVscodeSession(s));
	}

	async createSession(_scopes: readonly string[]): Promise<vscode.AuthenticationSession> {
		// Guard: if a session already exists, return it (don't re-open the modal).
		await this._ensureSessionsLoaded();
		if (this._sessions.length > 0) {
			return this._toVscodeSession(this._sessions[0]);
		}

		// Guard: prevent two concurrent calls (e.g. status bar click + VS Code account menu)
		// from opening two login panels simultaneously.
		if (this._loginInProgress) {
			const err = new Error('Sign-in already in progress.');
			(err as NodeJS.ErrnoException).code = 'ERR_CANCELLED';
			throw err;
		}
		this._loginInProgress = true;

		// Capture the auth response from a successful server login so we can build the
		// StoredSession without issuing a second login call after the panel closes.
		let capturedAuth: Awaited<ReturnType<typeof this._serverClient.login>> | null = null;
		const trySignIn = async (email: string, password: string): Promise<void> => {
			capturedAuth = await this._serverClient.login(email, password);
		};

		let result: import('./LoginWebviewPanel').LoginResult | null;
		try {
			result = await LoginWebviewPanel.show(this._context, this._serverClient, trySignIn);
		} finally {
			this._loginInProgress = false;
		}

		if (!result) {
			const err = new Error('Sign-in was cancelled by the user.');
			(err as NodeJS.ErrnoException).code = 'ERR_CANCELLED';
			throw err;
		}

		let session: StoredSession;
		if (capturedAuth) {
			// Credentials login -- tokens already set by serverClient.login() inside trySignIn.
			const authResponse = capturedAuth as Awaited<ReturnType<typeof this._serverClient.login>>;
			const sessionId = this._generateId();
			session = {
				id: sessionId,
				accessToken: authResponse.access_token,
				refreshToken: authResponse.refresh_token,
				expiresAt: Date.now() + authResponse.expires_in * 1000,
				email: authResponse.user.email,
				name: authResponse.user.name,
				tier: authResponse.user.tier,
				isEmailVerified: (authResponse.user as { is_email_verified?: boolean }).is_email_verified ?? false,
				avatarUrl: (authResponse.user as { avatar_url?: string }).avatar_url,
			};
			this._sessions = [session];
			// Ensure auth gate is resolved (login() may not have resolved it if called
			// before markAuthFlowComplete -- setSessionTokens handles the resolve safely).
			this._serverClient.setSessionTokens(
				session.accessToken, session.refreshToken, session.expiresAt, authResponse.user
			);
		} else {
			// Demo login -- handled by _performLogin.
			session = await this._performLogin(result);
		}

		await this._persistSessions();

		this._sessionChangeEmitter.fire({ added: [this._toVscodeSession(session)], removed: [], changed: [] });
		return this._toVscodeSession(session);
	}

	async removeSession(sessionId: string): Promise<void> {
		await this._ensureSessionsLoaded();
		const idx = this._sessions.findIndex(s => s.id === sessionId);
		if (idx === -1) { return; }

		const [removed] = this._sessions.splice(idx, 1);
		await this._persistSessions();

		// Call server logout endpoint directly (bypass ensureAuthenticated to avoid refresh).
		try {
			await this._serverClient.logoutSession(removed.refreshToken);
		} catch {
			// Best-effort -- local session is already cleared.
		}

		this._serverClient.clearTokens();
		this._sessionChangeEmitter.fire({ added: [], removed: [this._toVscodeSession(removed)], changed: [] });
	}

	dispose(): void {
		this._sessionChangeEmitter.dispose();
		this._disposables.forEach(d => d.dispose());
	}

	// -- Public helpers ----------------------------------------------------------

	/**
	 * Load any persisted session from SecretStorage and push its tokens into
	 * ServerApiClient so all pending API calls can proceed.
	 * Returns true if a session was found and loaded.
	 */
	async initializeFromStorage(): Promise<boolean> {
		await this._ensureSessionsLoaded();
		if (this._sessions.length === 0) { return false; }

		const s = this._sessions[0];
		// Reconstruct a ServerUser from stored fields (user.id not stored -- use email as surrogate).
		this._serverClient.setSessionTokens(
			s.accessToken,
			s.refreshToken,
			s.expiresAt,
			{ id: s.email, email: s.email, name: s.name, tier: s.tier }
		);
		return true;
	}

	/**
	 * Run migration from old qic.deltaplusXxx SecretStorage keys to the new format.
	 * Call once during extension activation after this provider is registered.
	 */
	async runMigration(): Promise<void> {
		// Skip if already done.
		const done = await this._context.secrets.get(MIGRATION_DONE_KEY);
		if (done) { return; }

		// Skip if new-format sessions already exist.
		const existing = await this._context.secrets.get(SESSIONS_KEY);
		if (existing) {
			await this._context.secrets.store(MIGRATION_DONE_KEY, '1');
			return;
		}

		const oldAccess = await this._context.secrets.get(LEGACY_ACCESS_KEY);
		if (!oldAccess) {
			await this._context.secrets.store(MIGRATION_DONE_KEY, '1');
			return;
		}

		// Decode expiry to check freshness.
		const oldExpiryStr = await this._context.secrets.get(LEGACY_EXPIRY_KEY);
		const oldExpiry = oldExpiryStr ? parseInt(oldExpiryStr, 10) : 0;

		let user: ServerUser | null = null;
		if (oldExpiry > Date.now()) {
			// Access token still valid -- fetch user info.
			try {
				user = await this._serverClient.fetchCurrentUser(oldAccess);
			} catch {
				// Token may be from another user or corrupt -- discard.
			}
		} else {
			// Access token expired -- try to refresh.
			const oldRefresh = await this._context.secrets.get(LEGACY_REFRESH_KEY);
			if (oldRefresh) {
				try {
					const refreshed = await this._serverClient.refreshWithToken(oldRefresh);
					// Server may omit `user` in refresh responses. Fall back to /v1/auth/me if so.
					let refreshedUser: ServerUser | null = refreshed.user ?? null;
					if (!refreshedUser) {
						try {
							refreshedUser = await this._serverClient.fetchCurrentUser(refreshed.access_token);
						} catch {
							// Can't get user info -- skip migration.
						}
					}
					if (!refreshedUser) {
						// No user info available -- cannot reconstruct the session.
						// (demo@deltaplus.io is NOT special-cased: it is the real
						// demo account and migrates like any other user, M134.)
						await this._context.secrets.store(MIGRATION_DONE_KEY, '1');
						return;
					}
					const expiresAt = Date.now() + refreshed.expires_in * 1000;
					// setSessionTokens handles persisting and resolving the auth gate.
					this._serverClient.setSessionTokens(
						refreshed.access_token,
						refreshed.refresh_token,
						expiresAt,
						refreshedUser
					);
					const migratedId = this._generateId();
					const migratedSession: StoredSession = {
						id: migratedId,
						accessToken: refreshed.access_token,
						refreshToken: refreshed.refresh_token,
						expiresAt,
						email: refreshedUser.email,
						name: refreshedUser.name,
						tier: refreshedUser.tier,
						isEmailVerified: true,
					};
					this._sessions = [migratedSession];
					await this._persistSessions();
					await this._context.secrets.store(MIGRATION_DONE_KEY, '1');
					this._sessionChangeEmitter.fire({ added: [this._toVscodeSession(migratedSession)], removed: [], changed: [] });
					return;
				} catch {
					// Refresh failed -- discard stale session.
				}
			}
		}

		if (user) {
			// Migrate the session (demo@deltaplus.io included -- it is the real
			// demo account, M134; only sessions with no resolvable user are dropped).
			const oldRefresh = await this._context.secrets.get(LEGACY_REFRESH_KEY) ?? '';
			const migratedId = this._generateId();
			const migratedSession: StoredSession = {
				id: migratedId,
				accessToken: oldAccess,
				refreshToken: oldRefresh,
				expiresAt: oldExpiry,
				email: user.email,
				name: user.name,
				tier: user.tier,
				isEmailVerified: true,
			};
			this._sessions = [migratedSession];
			await this._persistSessions();
			this._sessionChangeEmitter.fire({ added: [this._toVscodeSession(migratedSession)], removed: [], changed: [] });
		}

		await this._context.secrets.store(MIGRATION_DONE_KEY, '1');
	}

	// -- Direct sign-in methods (used by authGate and re-auth flows) -------------

	/** Sign in with email + password and persist the session. */
	async signInWithCredentials(email: string, password: string): Promise<void> {
		await this._ensureSessionsLoaded();
		const authResponse = await this._serverClient.login(email, password);
		const session = this._buildSession(authResponse);
		this._sessions = [session];
		this._serverClient.setSessionTokens(session.accessToken, session.refreshToken, session.expiresAt, authResponse.user);
		await this._persistSessions();
		this._sessionChangeEmitter.fire({ added: [this._toVscodeSession(session)], removed: [], changed: [] });
	}

	/**
	 * Sign in with the demo account and persist the session.
	 * Used by the auth gate and re-auth flows.
	 */
	async signInWithDemo(): Promise<void> {
		await this._ensureSessionsLoaded();
		const authResponse = await this._serverClient.loginWithDemo();
		const session = this._buildSession(authResponse);
		this._sessions = [session];
		this._serverClient.setSessionTokens(session.accessToken, session.refreshToken, session.expiresAt, authResponse.user);
		await this._persistSessions();
		this._sessionChangeEmitter.fire({ added: [this._toVscodeSession(session)], removed: [], changed: [] });
	}

	/**
	 * Register a new account, then immediately sign in.
	 * Used by the auth gate and re-auth flows.
	 */
	async registerAndSignIn(email: string, password: string, name: string): Promise<void> {
		await this._serverClient.register(email, password, name);
		await this.signInWithCredentials(email, password);
	}

	// -- Private helpers ---------------------------------------------------------

	private _buildSession(authResponse: AuthResponse): StoredSession {
		return {
			id: this._generateId(),
			accessToken: authResponse.access_token,
			refreshToken: authResponse.refresh_token,
			expiresAt: Date.now() + authResponse.expires_in * 1000,
			email: authResponse.user.email,
			name: authResponse.user.name,
			tier: authResponse.user.tier,
			isEmailVerified: (authResponse.user as { is_email_verified?: boolean }).is_email_verified ?? false,
			avatarUrl: (authResponse.user as { avatar_url?: string }).avatar_url,
		};
	}

	private async _ensureSessionsLoaded(): Promise<void> {
		if (this._sessionsLoaded) { return; }
		// Mutex: coalesce concurrent callers onto a single SecretStorage read.
		if (!this._sessionsLoadingPromise) {
			this._sessionsLoadingPromise = (async () => {
				try {
					const raw = await this._context.secrets.get(SESSIONS_KEY);
					this._sessions = raw ? (JSON.parse(raw) as StoredSession[]) : [];
				} catch {
					this._sessions = [];
				} finally {
					this._sessionsLoaded = true;
					this._sessionsLoadingPromise = null;
				}
			})();
		}
		return this._sessionsLoadingPromise;
	}

	private async _persistSessions(): Promise<void> {
		await this._context.secrets.store(SESSIONS_KEY, JSON.stringify(this._sessions));
	}

	private async _performLogin(result: LoginResult): Promise<StoredSession> {
		let authResponse: Awaited<ReturnType<typeof this._serverClient.login>>;

		if (result.type === 'demo') {
			authResponse = await this._serverClient.loginWithDemo();
		} else {
			authResponse = await this._serverClient.login(result.email, result.password);
		}

		const sessionId = this._generateId();
		const session: StoredSession = {
			id: sessionId,
			accessToken: authResponse.access_token,
			refreshToken: authResponse.refresh_token,
			expiresAt: Date.now() + authResponse.expires_in * 1000,
			email: authResponse.user.email,
			name: authResponse.user.name,
			tier: authResponse.user.tier,
			isEmailVerified: (authResponse.user as { is_email_verified?: boolean }).is_email_verified ?? false,
			avatarUrl: (authResponse.user as { avatar_url?: string }).avatar_url,
		};

		this._sessions = [session]; // single-account provider

		// Push tokens to ServerApiClient (resolves auth-ready gate).
		this._serverClient.setSessionTokens(
			session.accessToken,
			session.refreshToken,
			session.expiresAt,
			authResponse.user
		);

		return session;
	}

	/**
	 * Called when ServerApiClient fires onAuthStateChange(false) -- typically when the
	 * refresh token has expired server-side. Purges the stale session from SecretStorage
	 * so the auth gate can detect the cleared state and re-show the sign-in screen.
	 */
	private async _purgeExpiredSession(): Promise<void> {
		if (this._sessions.length === 0) { return; } // already cleared (e.g. explicit sign-out)
		const removed = this._sessions.slice();
		this._sessions = [];
		await this._persistSessions();
		this._sessionChangeEmitter.fire({
			added: [],
			removed: removed.map(s => this._toVscodeSession(s)),
			changed: [],
		});
	}

	/** Called when ServerApiClient fires onAuthStateChange(true) after a token refresh. */
	private async _syncTokensFromClient(): Promise<void> {
		await this._ensureSessionsLoaded();
		if (this._sessions.length === 0) { return; }

		const newAccess = this._serverClient.getAccessToken();
		const newRefresh = this._serverClient.getRefreshToken();
		const newExpiry = this._serverClient.getTokenExpiresAt();

		if (!newAccess) { return; }

		const old = this._sessions[0];
		if (old.accessToken === newAccess) { return; } // no change

		const updated: StoredSession = { ...old, accessToken: newAccess, refreshToken: newRefresh ?? old.refreshToken, expiresAt: newExpiry };
		this._sessions = [updated];
		await this._persistSessions();
		this._sessionChangeEmitter.fire({ added: [], removed: [], changed: [this._toVscodeSession(updated)] });
	}

	/**
	 * Called when another code path (auth gate, another window) updates SESSIONS_KEY.
	 * Loads the new session and immediately pushes tokens to serverClient so the
	 * WebSocket connects without waiting for the next API call.
	 */
	private async _handleExternalSessionChange(): Promise<void> {
		const previous = this._sessions.slice();
		this._sessionsLoaded = false;
		await this._ensureSessionsLoaded();

		const added = this._sessions.filter(s => !previous.some(p => p.id === s.id));
		const removed = previous.filter(p => !this._sessions.some(s => s.id === p.id));

		if (added.length === 0 && removed.length === 0) { return; }

		// Push new tokens into serverClient so WebSocket can connect immediately.
		if (added.length > 0 && this._sessions.length > 0) {
			const s = this._sessions[0];
			this._serverClient.setSessionTokens(
				s.accessToken, s.refreshToken, s.expiresAt,
				{ id: s.email, email: s.email, name: s.name, tier: s.tier }
			);
		} else if (removed.length > 0 && this._sessions.length === 0) {
			this._serverClient.clearTokens();
		}

		this._sessionChangeEmitter.fire({
			added: added.map(s => this._toVscodeSession(s)),
			removed: removed.map(s => this._toVscodeSession(s)),
			changed: []
		});
	}

	private _toVscodeSession(s: StoredSession): vscode.AuthenticationSession {
		return {
			id: s.id,
			accessToken: s.accessToken,
			account: { id: s.email, label: s.name || s.email },
			scopes: ['read'],
		};
	}

	private _generateId(): string {
		return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	}
}

export { PROVIDER_ID as DELTAPLUS_PROVIDER_ID };
