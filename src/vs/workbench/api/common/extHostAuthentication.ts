/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import * as nls from '../../../nls.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { MainContext, MainThreadAuthenticationShape, ExtHostAuthenticationShape } from './extHost.protocol.js';
import { Disposable, ProgressLocation } from './extHostTypes.js';
import { IExtensionDescription, ExtensionIdentifier } from '../../../platform/extensions/common/extensions.js';
import { INTERNAL_AUTH_PROVIDER_PREFIX, isAuthenticationWwwAuthenticateRequest } from '../../services/authentication/common/authentication.js';
import { createDecorator } from '../../../platform/instantiation/common/instantiation.js';
import { IExtHostRpcService } from './extHostRpcService.js';
import { URI, UriComponents } from '../../../base/common/uri.js';
import { AuthorizationErrorType, createOAuthHttpError, createOAuthInvalidResponseError, createOAuthTransportError, describeOAuthFailure, fetchDynamicRegistration, formatOAuthHttpFailure, getClaimsFromJWT, IAuthorizationJWTClaims, IAuthorizationProtectedResourceMetadata, IAuthorizationServerMetadata, IAuthorizationTokenResponse, isAuthorizationErrorResponse, isValidAuthorizationTokenResponse, OAuthBodyOutcome, OAuthSafeError, readOAuthErrorBody, readOAuthJsonResponse } from '../../../base/common/oauth.js';
import { IExtHostWindow } from './extHostWindow.js';
import { IExtHostInitDataService } from './extHostInitDataService.js';
import { ILogger, ILoggerService, ILogService } from '../../../platform/log/common/log.js';
import { autorun, derivedOpts, IObservable, ISettableObservable, observableValue } from '../../../base/common/observable.js';
import { StringSHA1 } from '../../../base/common/hash.js';
import { generateUuid } from '../../../base/common/uuid.js';
import { DisposableStore, IDisposable } from '../../../base/common/lifecycle.js';
import { IExtHostUrlsService } from './extHostUrls.js';
import { encodeBase64, VSBuffer } from '../../../base/common/buffer.js';
import { equals as arraysEqual } from '../../../base/common/arrays.js';
import { IExtHostProgress } from './extHostProgress.js';
import { IProgressStep } from '../../../platform/progress/common/progress.js';
import { CancellationError, isCancellationError } from '../../../base/common/errors.js';
import { raceCancellationError, Sequencer, SequencerByKey } from '../../../base/common/async.js';

export interface IExtHostAuthentication extends ExtHostAuthentication { }

/**
 * The class of an error, for a log line or an error message on an authentication path: an error's text (a response body,
 * a request, a token) is not safe by construction, so it is never shown.
 */
export function errorClassName(error: unknown): string {
	return error instanceof Error ? error.name : typeof error;
}

/**
 * Scopes for a log line: their count, never their values. A scope can come from a server (an MCP WWW-Authenticate challenge
 * or the resource metadata's scopes_supported), so its text is not a log value. The scopes used for authentication are not
 * changed.
 */
export function scopeCountText(scopes: readonly string[]): string {
	return `${scopes.length} scope(s)`;
}
export const IExtHostAuthentication = createDecorator<IExtHostAuthentication>('IExtHostAuthentication');

interface ProviderWithMetadata {
	label: string;
	provider: vscode.AuthenticationProvider;
	disposable?: vscode.Disposable;
	options: vscode.AuthenticationProviderOptions;
}

export class ExtHostAuthentication implements ExtHostAuthenticationShape {

	declare _serviceBrand: undefined;

	protected readonly _dynamicAuthProviderCtor = DynamicAuthProvider;

	private _proxy: MainThreadAuthenticationShape;
	private _authenticationProviders: Map<string, ProviderWithMetadata> = new Map<string, ProviderWithMetadata>();
	private _providerOperations = new SequencerByKey<string>();

	private _onDidChangeSessions = new Emitter<vscode.AuthenticationSessionsChangeEvent & { extensionIdFilter?: string[] }>();
	private _getSessionTaskSingler = new TaskSingler<vscode.AuthenticationSession | undefined>();

	private _onDidDynamicAuthProviderTokensChange = new Emitter<{ authProviderId: string; clientId: string; tokens: IAuthorizationToken[] }>();

	constructor(
		@IExtHostRpcService extHostRpc: IExtHostRpcService,
		@IExtHostInitDataService private readonly _initData: IExtHostInitDataService,
		@IExtHostWindow private readonly _extHostWindow: IExtHostWindow,
		@IExtHostUrlsService private readonly _extHostUrls: IExtHostUrlsService,
		@IExtHostProgress private readonly _extHostProgress: IExtHostProgress,
		@ILoggerService private readonly _extHostLoggerService: ILoggerService,
		@ILogService private readonly _logService: ILogService,
	) {
		this._proxy = extHostRpc.getProxy(MainContext.MainThreadAuthentication);
	}

	/**
	 * This sets up an event that will fire when the auth sessions change with a built-in filter for the extensionId
	 * if a session change only affects a specific extension.
	 * @param extensionId The extension that is interested in the event.
	 * @returns An event with a built-in filter for the extensionId
	 */
	getExtensionScopedSessionsEvent(extensionId: string): Event<vscode.AuthenticationSessionsChangeEvent> {
		const normalizedExtensionId = extensionId.toLowerCase();
		return Event.chain(this._onDidChangeSessions.event, ($) => $
			.filter(e => !e.extensionIdFilter || e.extensionIdFilter.includes(normalizedExtensionId))
			.map(e => ({ provider: e.provider }))
		);
	}

	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions & ({ createIfNone: true } | { forceNewSession: true } | { forceNewSession: vscode.AuthenticationForceNewSessionOptions })): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions & { forceNewSession: true }): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions & { forceNewSession: vscode.AuthenticationForceNewSessionOptions }): Promise<vscode.AuthenticationSession>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions): Promise<vscode.AuthenticationSession | undefined>;
	async getSession(requestingExtension: IExtensionDescription, providerId: string, scopesOrRequest: readonly string[] | vscode.AuthenticationWwwAuthenticateRequest, options: vscode.AuthenticationGetSessionOptions = {}): Promise<vscode.AuthenticationSession | undefined> {
		const extensionId = ExtensionIdentifier.toKey(requestingExtension.identifier);
		const keys: (keyof vscode.AuthenticationGetSessionOptions)[] = Object.keys(options) as (keyof vscode.AuthenticationGetSessionOptions)[];
		// TODO: pull this out into a utility function somewhere
		const optionsStr = keys
			.map(key => {
				switch (key) {
					case 'account':
						return `${key}:${options.account?.id}`;
					case 'createIfNone':
					case 'forceNewSession': {
						const value = typeof options[key] === 'boolean'
							? `${options[key]}`
							: `'${options[key]?.detail}/${options[key]?.learnMore?.toString()}'`;
						return `${key}:${value}`;
					}
					case 'authorizationServer':
						return `${key}:${options.authorizationServer?.toString(true)}`;
					default:
						return `${key}:${!!options[key]}`;
				}
			})
			.sort()
			.join(', ');

		let singlerKey: string;
		if (isAuthenticationWwwAuthenticateRequest(scopesOrRequest)) {
			const challenge = scopesOrRequest as vscode.AuthenticationWwwAuthenticateRequest;
			const challengeStr = challenge.wwwAuthenticate;
			const scopesStr = challenge.fallbackScopes ? [...challenge.fallbackScopes].sort().join(' ') : '';
			singlerKey = `${extensionId} ${providerId} challenge:${challengeStr} ${scopesStr} ${optionsStr}`;
		} else {
			const sortedScopes = [...scopesOrRequest].sort().join(' ');
			singlerKey = `${extensionId} ${providerId} ${sortedScopes} ${optionsStr}`;
		}

		return await this._getSessionTaskSingler.getOrCreate(singlerKey, async () => {
			await this._proxy.$ensureProvider(providerId);
			const extensionName = requestingExtension.displayName || requestingExtension.name;
			return this._proxy.$getSession(providerId, scopesOrRequest, extensionId, extensionName, options);
		});
	}

	async getAccounts(providerId: string) {
		await this._proxy.$ensureProvider(providerId);
		return await this._proxy.$getAccounts(providerId);
	}

	registerAuthenticationProvider(id: string, label: string, provider: vscode.AuthenticationProvider, options?: vscode.AuthenticationProviderOptions): vscode.Disposable {
		// register
		void this._providerOperations.queue(id, async () => {
			// This use to be synchronous, but that wasn't an accurate representation because the main thread
			// may have unregistered the provider in the meantime. I don't see how this could really be done
			// synchronously, so we just say first one wins.
			if (this._authenticationProviders.get(id)) {
				this._logService.error(`An authentication provider with id '${id}' is already registered. The existing provider will not be replaced.`);
				return;
			}
			const listener = provider.onDidChangeSessions(e => this._proxy.$sendDidChangeSessions(id, e));
			this._authenticationProviders.set(id, { label, provider, disposable: listener, options: options ?? { supportsMultipleAccounts: false } });
			await this._proxy.$registerAuthenticationProvider({
				id,
				label,
				supportsMultipleAccounts: options?.supportsMultipleAccounts ?? false,
				supportedAuthorizationServers: options?.supportedAuthorizationServers,
				supportsChallenges: options?.supportsChallenges
			});
		});

		// unregister
		return new Disposable(() => {
			void this._providerOperations.queue(id, async () => {
				const providerData = this._authenticationProviders.get(id);
				if (providerData) {
					providerData.disposable?.dispose();
					this._authenticationProviders.delete(id);
					await this._proxy.$unregisterAuthenticationProvider(id);
				}
			});
		});
	}

	$createSession(providerId: string, scopes: string[], options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				options.authorizationServer = URI.revive(options.authorizationServer);
				return await providerData.provider.createSession(scopes, options);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$removeSession(providerId: string, sessionId: string): Promise<void> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				return await providerData.provider.removeSession(sessionId);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$getSessions(providerId: string, scopes: ReadonlyArray<string> | undefined, options: vscode.AuthenticationProviderSessionOptions): Promise<ReadonlyArray<vscode.AuthenticationSession>> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				options.authorizationServer = URI.revive(options.authorizationServer);
				return await providerData.provider.getSessions(scopes, options);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$getSessionsFromChallenges(providerId: string, constraint: vscode.AuthenticationConstraint, options: vscode.AuthenticationProviderSessionOptions): Promise<ReadonlyArray<vscode.AuthenticationSession>> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				const provider = providerData.provider;
				// Check if provider supports challenges
				if (typeof provider.getSessionsFromChallenges === 'function') {
					options.authorizationServer = URI.revive(options.authorizationServer);
					return await provider.getSessionsFromChallenges(constraint, options);
				}
				throw new Error(`Authentication provider with handle: ${providerId} does not support getSessionsFromChallenges`);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$createSessionFromChallenges(providerId: string, constraint: vscode.AuthenticationConstraint, options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		return this._providerOperations.queue(providerId, async () => {
			const providerData = this._authenticationProviders.get(providerId);
			if (providerData) {
				const provider = providerData.provider;
				// Check if provider supports challenges
				if (typeof provider.createSessionFromChallenges === 'function') {
					options.authorizationServer = URI.revive(options.authorizationServer);
					return await provider.createSessionFromChallenges(constraint, options);
				}
				throw new Error(`Authentication provider with handle: ${providerId} does not support createSessionFromChallenges`);
			}

			throw new Error(`Unable to find authentication provider with handle: ${providerId}`);
		});
	}

	$onDidChangeAuthenticationSessions(id: string, label: string, extensionIdFilter?: string[]) {
		// Don't fire events for the internal auth providers
		if (!id.startsWith(INTERNAL_AUTH_PROVIDER_PREFIX)) {
			this._onDidChangeSessions.fire({ provider: { id, label }, extensionIdFilter });
		}
		return Promise.resolve();
	}

	$onDidUnregisterAuthenticationProvider(id: string): Promise<void> {
		return this._providerOperations.queue(id, async () => {
			const providerData = this._authenticationProviders.get(id);
			if (providerData) {
				providerData.disposable?.dispose();
				this._authenticationProviders.delete(id);
			}
		});
	}

	async $registerDynamicAuthProvider(
		authorizationServerComponents: UriComponents,
		serverMetadata: IAuthorizationServerMetadata,
		resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined,
		clientId: string | undefined,
		clientSecret: string | undefined,
		initialTokens: IAuthorizationToken[] | undefined
	): Promise<string> {
		if (!clientId) {
			const authorizationServer = URI.revive(authorizationServerComponents);
			if (serverMetadata.registration_endpoint) {
				try {
					const registration = await fetchDynamicRegistration(serverMetadata, this._initData.environment.appName, resourceMetadata?.scopes_supported);
					clientId = registration.client_id;
					clientSecret = registration.client_secret;
				} catch (err) {
					// The issuer string is supplied by the server and can carry credentials: it is not logged
					this._logService.warn(`Dynamic registration failed: ${describeOAuthFailure(err, 'the registration request failed unexpectedly')}. Prompting user for client ID and client secret...`);
				}
			}
			// Still no client id so dynamic client registration was either not supported or failed
			if (!clientId) {
				this._logService.info('Prompting user for client registration details');
				let clientDetails: Awaited<ReturnType<MainThreadAuthenticationShape['$promptForClientRegistration']>>;
				try {
					clientDetails = await this._proxy.$promptForClientRegistration(authorizationServer.toString());
				} catch (promptError) {
					if (isCancellationError(promptError)) {
						// A received cancellation is recognised by name and message only: its stack and properties are not trusted, so it is replaced
						throw new CancellationError();
					}
					// The error comes from another process and its text and causes are not trusted: report a new error
					throw new OAuthSafeError('Failed to prompt for client registration details');
				}
				if (!clientDetails) {
					throw new Error('User did not provide client details');
				}
				clientId = clientDetails.clientId;
				clientSecret = clientDetails.clientSecret;
				this._logService.info('User provided client registration');
				if (clientSecret) {
					this._logService.trace('User provided client secret');
				} else {
					this._logService.trace('User did not provide client secret');
				}
			}
		}
		const provider = new this._dynamicAuthProviderCtor(
			this._extHostWindow,
			this._extHostUrls,
			this._initData,
			this._extHostProgress,
			this._extHostLoggerService,
			this._proxy,
			URI.revive(authorizationServerComponents),
			serverMetadata,
			resourceMetadata,
			clientId,
			clientSecret,
			this._onDidDynamicAuthProviderTokensChange,
			initialTokens || []
		);

		// Use the sequencer to ensure dynamic provider registration is serialized. A call for this provider from the main
		// thread (which publishes it once saved) queues behind this operation, so it finds the provider installed below.
		try {
			await this._providerOperations.queue(provider.id, async () => {
				// The main thread validates and saves the registration before it publishes the provider; it is installed here
				// only after that resolves. A client-ID change is saved by the provider itself (_generateNewClientId).
				await this._proxy.$registerDynamicAuthenticationProvider({
					id: provider.id,
					label: provider.label,
					supportsMultipleAccounts: true,
					authorizationServer: authorizationServerComponents,
					resourceServer: resourceMetadata ? URI.parse(resourceMetadata.resource) : undefined,
					clientId: provider.clientId,
					clientSecret: provider.clientSecret
				});

				this._authenticationProviders.set(
					provider.id,
					{
						label: provider.label,
						provider,
						disposable: Disposable.from(
							provider,
							provider.onDidChangeSessions(e => this._proxy.$sendDidChangeSessions(provider.id, e))
						),
						options: { supportsMultipleAccounts: true }
					}
				);
			});
		} catch (error) {
			// Not saved, so published on neither side: the provisional provider is disposed and the rejection is the caller's.
			provider.dispose();
			throw error;
		}

		return provider.id;
	}

	async $onDidChangeDynamicAuthProviderTokens(authProviderId: string, clientId: string, tokens: IAuthorizationToken[]): Promise<void> {
		this._onDidDynamicAuthProviderTokensChange.fire({ authProviderId, clientId, tokens });
	}
}

class TaskSingler<T> {
	private _inFlightPromises = new Map<string, Promise<T>>();
	getOrCreate(key: string, promiseFactory: () => Promise<T>) {
		const inFlight = this._inFlightPromises.get(key);
		if (inFlight) {
			return inFlight;
		}

		const promise = promiseFactory().finally(() => this._inFlightPromises.delete(key));
		this._inFlightPromises.set(key, promise);

		return promise;
	}
}

/** The id of the explicit reset of a stored dynamic client registration and its sessions (RemoveDynamicAuthenticationProvidersAction). */
const REMOVE_DYNAMIC_AUTH_PROVIDERS_COMMAND_ID = 'workbench.action.removeDynamicAuthenticationProviders';

/**
 * Refreshing stored sessions failed. They stay stored: a failure may be transient, and a refresh token is a credential.
 * Only an explicit act of the user (signing out, or removing the provider) removes them. The message carries no token and
 * no issuer string: `label` is the provider's issuer-free display name ({@link DynamicAuthProvider} `_errorLabel`).
 */
export class DynamicAuthSessionRefreshError extends Error {
	override readonly name = 'DynamicAuthSessionRefreshError';
	constructor(label: string, count: number) {
		super(nls.localize('dynamicAuthSessionRefreshFailed', "Refreshing {0} stored session(s) of '{1}' failed; they are kept. Try again, sign out and sign in again, or remove them with the command 'Authentication: Remove Dynamic Authentication Providers' ({2}).", count, label, REMOVE_DYNAMIC_AUTH_PROVIDERS_COMMAND_ID));
	}
}

/**
 * Stored sessions have expired and carry no refresh token. They stay stored: only an explicit act of the user (signing
 * out, or removing the provider) removes them. The message carries no token and no issuer string (see `label` above).
 */
export class DynamicAuthSessionExpiredError extends Error {
	override readonly name = 'DynamicAuthSessionExpiredError';
	constructor(label: string, count: number) {
		super(nls.localize('dynamicAuthSessionExpired', "{0} stored session(s) of '{1}' have expired and cannot be refreshed; they are kept. Sign out and sign in again, or remove them with the command 'Authentication: Remove Dynamic Authentication Providers' ({2}).", count, label, REMOVE_DYNAMIC_AUTH_PROVIDERS_COMMAND_ID));
	}
}

/**
 * The authorization server rejected the stored client registration (invalid_client). It is kept, with its sessions: a new
 * registration is made only after an explicit act of the user has removed the stored one. The message carries no secret
 * and no issuer string (see `label` above).
 */
export class DynamicAuthClientRejectedError extends Error {
	override readonly name = 'DynamicAuthClientRejectedError';
	constructor(label: string) {
		super(nls.localize('dynamicAuthClientRejected', "The authorization server rejected the stored client registration of '{0}'; it is kept. Remove it with the command 'Authentication: Remove Dynamic Authentication Providers' ({1}), then sign in again.", label, REMOVE_DYNAMIC_AUTH_PROVIDERS_COMMAND_ID));
	}
}

/**
 * Changed sessions could not be saved to secret storage (for example encryption is unavailable). The change is kept as
 * pending in this window and saved by the next operation, which reports success only once it is saved; until then the
 * stored sessions are the previous ones. No completed-change event is published for it. The message carries no token.
 */
export class DynamicAuthSessionPersistError extends Error {
	override readonly name = 'DynamicAuthSessionPersistError';
	constructor(count: number, failure: string) {
		super(nls.localize('dynamicAuthSessionPersistFailed', "{0} session(s) could not be saved to secret storage ({1}); the change is kept in this window and saved by the next sign-in operation. Until then it is lost on restart.", count, failure));
	}
}

export class DynamicAuthProvider implements vscode.AuthenticationProvider {
	readonly id: string;
	readonly label: string;

	private _onDidChangeSessions = new Emitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _onDidChangeClientId = new Emitter<void>();
	readonly onDidChangeClientId = this._onDidChangeClientId.event;

	private readonly _tokenStore: TokenStore;

	protected readonly _createFlows: Array<{
		label: string;
		handler: (scopes: string[], progress: vscode.Progress<{ message: string }>, token: vscode.CancellationToken) => Promise<IAuthorizationTokenResponse>;
	}>;

	protected readonly _logger: ILogger;
	/** The provider's display name for an error message: {@link label} without the user info of the issuer's authority. */
	protected readonly _errorLabel: string;
	private readonly _disposable: DisposableStore;

	constructor(
		@IExtHostWindow protected readonly _extHostWindow: IExtHostWindow,
		@IExtHostUrlsService protected readonly _extHostUrls: IExtHostUrlsService,
		@IExtHostInitDataService protected readonly _initData: IExtHostInitDataService,
		@IExtHostProgress private readonly _extHostProgress: IExtHostProgress,
		@ILoggerService loggerService: ILoggerService,
		protected readonly _proxy: MainThreadAuthenticationShape,
		readonly authorizationServer: URI,
		protected readonly _serverMetadata: IAuthorizationServerMetadata,
		protected readonly _resourceMetadata: IAuthorizationProtectedResourceMetadata | undefined,
		protected _clientId: string,
		protected _clientSecret: string | undefined,
		onDidDynamicAuthProviderTokensChange: Emitter<{ authProviderId: string; clientId: string; tokens: IAuthorizationToken[] }>,
		initialTokens: IAuthorizationToken[],
	) {
		const stringifiedServer = authorizationServer.toString(true);
		// Auth Provider Id is a combination of the authorization server and the resource, if provided.
		this.id = _resourceMetadata?.resource
			? stringifiedServer + ' ' + _resourceMetadata?.resource
			: stringifiedServer;
		// Auth Provider label is just the resource name if provided, otherwise the authority of the authorization server.
		this.label = _resourceMetadata?.resource_name ?? this.authorizationServer.authority;
		// An error message names the provider without the issuer string: the authority's user info can hold a credential, so
		// it is cut off (the id, which is the whole issuer string, is never put in an error).
		const authority = this.authorizationServer.authority;
		this._errorLabel = _resourceMetadata?.resource_name ?? authority.slice(authority.lastIndexOf('@') + 1);

		this._logger = loggerService.createLogger(this.id, { name: `Auth: ${this.label}` });
		this._disposable = new DisposableStore();
		this._disposable.add(this._onDidChangeSessions);
		const scopedEvent = Event.chain(onDidDynamicAuthProviderTokensChange.event, $ => $
			.filter(e => e.authProviderId === this.id && e.clientId === _clientId)
			.map(e => e.tokens)
		);
		this._tokenStore = this._disposable.add(new TokenStore(
			{
				onDidChange: scopedEvent,
				set: (tokens) => _proxy.$setSessionsForDynamicAuthProvider(this.id, this.clientId, tokens),
			},
			initialTokens,
			this._logger
		));
		this._disposable.add(this._tokenStore.onDidChangeSessions(e => this._onDidChangeSessions.fire(e)));
		// Will be extended later to support other flows
		this._createFlows = [];
		if (_serverMetadata.authorization_endpoint) {
			this._createFlows.push({
				label: nls.localize('url handler', "URL Handler"),
				handler: (scopes, progress, token) => this._createWithUrlHandler(scopes, progress, token)
			});
		}
	}

	get clientId(): string {
		return this._clientId;
	}

	get clientSecret(): string | undefined {
		return this._clientSecret;
	}

	async getSessions(scopes: readonly string[] | undefined, _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession[]> {
		// Scope counts only, never values: a scope can come from a server (an MCP challenge or the resource metadata).
		this._logger.info(scopes ? `Getting sessions for ${scopeCountText(scopes)}` : 'Getting sessions for all scopes');
		// A change that could not be saved earlier is saved first: no read reports success over an unsaved credential.
		await this._tokenStore.savePending();
		if (!scopes) {
			return this._tokenStore.sessions;
		}
		// The oauth spec says tthat order doesn't matter so we sort the scopes for easy comparison
		// https://datatracker.ietf.org/doc/html/rfc6749#section-3.3
		// TODO@TylerLeonhardt: Do this for all scope handling in the auth APIs
		const sortedScopes = [...scopes].sort();
		const scopeStr = scopes.join(' ');
		let sessions = this._tokenStore.sessions.filter(session => arraysEqual([...session.scopes].sort(), sortedScopes));
		this._logger.info(`Found ${sessions.length} sessions for ${scopeCountText(scopes)}`);
		if (sessions.length) {
			const removedTokens: ISessionToken[] = [];
			/** Each refreshed token and the token that replaces it. */
			const refreshedTokens = new Map<ISessionToken, IAuthorizationToken>();
			const expiredTokens: ISessionToken[] = [];
			const tokenMap = new Map<string, ISessionToken>(this._tokenStore.tokens.map(token => [token.access_token, token]));
			for (const session of sessions) {
				const token = tokenMap.get(session.accessToken);
				if (token && token.expires_in) {
					const now = Date.now();
					const expiresInMS = token.expires_in * 1000;
					// Check if the token is about to expire in 5 minutes or if it is expired
					if (now > token.created_at + expiresInMS - (5 * 60 * 1000)) {
						if (!token.refresh_token) {
							// No refresh token: a token that has not expired yet stays usable. An expired one stays stored (only an
							// explicit act of the user removes it) and this operation rejects, naming that act.
							if (now >= token.created_at + expiresInMS) {
								this._logger.warn(`Token for session ${session.id} has expired and has no refresh token; it is kept.`);
								expiredTokens.push(token);
							}
							continue;
						}
						this._logger.info(`Token for session ${session.id} is about to expire, refreshing...`);
						removedTokens.push(token);
						try {
							const newToken = await this.exchangeRefreshTokenForToken(token.refresh_token);
							// RFC 6749 section 6: the server may keep the refresh token and not return it. The stored one stays in use.
							if (newToken.refresh_token === undefined) {
								newToken.refresh_token = token.refresh_token;
							}
							// TODO@TylerLeonhardt: When the core scope handling doesn't care about order, this check should be
							// updated to not care about order
							if (newToken.scope !== scopeStr) {
								// The scope in the response is server text and is not repeated
								this._logger.warn('Token scopes do not match the requested scopes. Overwriting token with what was requested...');
								newToken.scope = scopeStr;
							}
							this._logger.info(`Successfully created a new token for ${scopeCountText(session.scopes)}.`);
							refreshedTokens.set(token, newToken);
						} catch (err) {
							this._logger.error(`Failed to refresh token: ${describeOAuthFailure(err, 'the refresh failed unexpectedly')}`);
						}

					}
				}
			}
			// A token whose refresh failed stays stored (a failure may be transient; its refresh token is a credential) and
			// this operation rejects. Only an explicit act of the user removes it: signing out, or removing the provider.
			const failedRefreshTokens = removedTokens.filter(t => !refreshedTokens.has(t));
			if (refreshedTokens.size) {
				await this._tokenStore.update({ refreshed: [...refreshedTokens].map(([previous, token]) => ({ previous, token })) });
				// Since we updated the tokens, we need to re-filter the sessions
				// to get the latest state
				sessions = this._tokenStore.sessions.filter(session => arraysEqual([...session.scopes].sort(), sortedScopes));
			}
			if (failedRefreshTokens.length) {
				throw new DynamicAuthSessionRefreshError(this._errorLabel, failedRefreshTokens.length);
			}
			if (expiredTokens.length) {
				throw new DynamicAuthSessionExpiredError(this._errorLabel, expiredTokens.length);
			}
			this._logger.info(`Found ${sessions.length} sessions for ${scopeCountText(scopes)}`);
			return sessions;
		}
		return [];
	}

	async createSession(scopes: string[], _options: vscode.AuthenticationProviderSessionOptions): Promise<vscode.AuthenticationSession> {
		this._logger.info(`Creating session for ${scopeCountText(scopes)}`);
		// Saved before the user is asked to sign in: a storage that cannot save would lose the new session too.
		await this._tokenStore.savePending();
		let token: IAuthorizationTokenResponse | undefined;
		let lastFlowError: unknown;
		for (let i = 0; i < this._createFlows.length; i++) {
			const { handler } = this._createFlows[i];
			try {
				token = await this._extHostProgress.withProgressFromSource(
					{ label: this.label, id: this.id },
					{
						location: ProgressLocation.Notification,
						title: nls.localize('authenticatingTo', "Authenticating to '{0}'", this.label),
						cancellable: true
					},
					(progress, token) => handler(scopes, progress, token));
				if (token) {
					break;
				}
			} catch (err) {
				if (err instanceof DynamicAuthClientRejectedError) {
					// Every flow uses the same client registration: stop, naming the explicit reset.
					throw err;
				}
				lastFlowError = err;
				const nextMode = this._createFlows[i + 1]?.label;
				if (!nextMode) {
					break; // No more flows to try
				}
				const message = isCancellationError(err)
					? nls.localize('userCanceledContinue', "Having trouble authenticating to '{0}'? Would you like to try a different way? ({1})", this.label, nextMode)
					: nls.localize('continueWith', "You have not yet finished authenticating to '{0}'. Would you like to try a different way? ({1})", this.label, nextMode);

				let result: boolean;
				try {
					result = await this._proxy.$showContinueNotification(message);
				} catch (notificationError) {
					if (isCancellationError(notificationError)) {
						// A received cancellation is recognised by name and message only: its stack and properties are not trusted, so it is replaced
						throw new CancellationError();
					}
					// The error comes from another process: report a new error without its text
					throw new OAuthSafeError('Failed to show the continue notification');
				}
				if (!result) {
					throw new CancellationError();
				}
				this._logger.error(`Failed to create token via flow '${this._createFlows[i].label}': ${describeOAuthFailure(err, 'the flow failed unexpectedly')}`);
			}
		}
		if (!token) {
			if (lastFlowError instanceof OAuthSafeError) {
				// Only an error of the safe type keeps its message; any other error from a flow is dropped
				throw new OAuthSafeError(`Failed to create authentication token: ${describeOAuthFailure(lastFlowError, 'the flow failed unexpectedly')}`);
			}
			throw new OAuthSafeError('Failed to create authentication token');
		}
		if (token.scope !== scopes.join(' ')) {
			// The scope in the response is server text and is not repeated
			this._logger.warn('Token scopes do not match the requested scopes. Overwriting token with what was requested...');
			token.scope = scopes.join(' ');
		}

		// Store session for later retrieval
		await this._tokenStore.update({ added: [{ ...token, created_at: Date.now() }] });
		const session = this._tokenStore.sessions.find(t => t.accessToken === token.access_token)!;
		this._logger.info(`Created ${token.refresh_token ? 'refreshable' : 'non-refreshable'} session for ${scopeCountText(scopes)}${token.expires_in ? ` that expires in ${token.expires_in} seconds` : ''}`);
		return session;
	}

	async removeSession(sessionId: string): Promise<void> {
		this._logger.info(`Removing session with id: ${sessionId}`);
		// A sign-out that failed to save is retried here: it reports success only once the removal is stored.
		await this._tokenStore.savePending();
		const session = this._tokenStore.sessions.find(session => session.id === sessionId);
		if (!session) {
			this._logger.error(`Session with id ${sessionId} not found`);
			return;
		}
		const token = this._tokenStore.tokens.find(token => token.access_token === session.accessToken);
		if (!token) {
			this._logger.error(`Failed to retrieve token for removed session: ${session.id}`);
			return;
		}
		await this._tokenStore.update({ removed: [token] });
		this._logger.info(`Removed token for session: ${session.id} with ${scopeCountText(session.scopes)}`);
	}

	dispose(): void {
		this._disposable.dispose();
	}

	private async _createWithUrlHandler(scopes: string[], progress: vscode.Progress<IProgressStep>, token: vscode.CancellationToken): Promise<IAuthorizationTokenResponse> {
		if (!this._serverMetadata.authorization_endpoint) {
			throw new Error('Authorization Endpoint required');
		}
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}

		// Generate PKCE code verifier (random string) and code challenge (SHA-256 hash of verifier)
		const codeVerifier = this.generateRandomString(64);
		const codeChallenge = await this.generateCodeChallenge(codeVerifier);

		// Generate a random state value to prevent CSRF
		const nonce = this.generateRandomString(32);
		const callbackUri = URI.parse(`${this._initData.environment.appUriScheme}://dynamicauthprovider/${this.authorizationServer.authority}/authorize?nonce=${nonce}`);
		let state: URI;
		try {
			state = await this._extHostUrls.createAppUri(callbackUri);
		} catch {
			// The error comes from another process: report a new error without its text
			throw new OAuthSafeError('Failed to create external URI');
		}

		// Prepare the authorization request URL
		const authorizationUrl = new URL(this._serverMetadata.authorization_endpoint);
		authorizationUrl.searchParams.append('client_id', this._clientId);
		authorizationUrl.searchParams.append('response_type', 'code');
		authorizationUrl.searchParams.append('state', state.toString());
		authorizationUrl.searchParams.append('code_challenge', codeChallenge);
		authorizationUrl.searchParams.append('code_challenge_method', 'S256');
		const scopeString = scopes.join(' ');
		if (scopeString) {
			// If non-empty scopes are provided, include scope parameter in the request
			authorizationUrl.searchParams.append('scope', scopeString);
		}
		if (this._resourceMetadata?.resource) {
			// If a resource is specified, include it in the request
			authorizationUrl.searchParams.append('resource', this._resourceMetadata.resource);
		}

		// Use a redirect URI that matches what was registered during dynamic registration
		const redirectUri = 'https://vscode.dev/redirect';
		authorizationUrl.searchParams.append('redirect_uri', redirectUri);

		const promise = this.waitForAuthorizationCode(callbackUri);

		// Open the browser for user authorization
		this._logger.info(`Opening authorization URL for ${scopeCountText(scopes)}`);
		let opened: boolean;
		try {
			opened = await this._extHostWindow.openUri(authorizationUrl.toString(), {});
		} catch (openError) {
			if (isCancellationError(openError)) {
				// A received cancellation is recognised by name and message only: its stack and properties are not trusted, so it is replaced
				throw new CancellationError();
			}
			// The error comes from another process and can quote the authorization URL: report a new error without its text
			throw new OAuthSafeError('Failed to open the authorization URL');
		}
		if (!opened) {
			throw new CancellationError();
		}
		progress.report({
			message: nls.localize('completeAuth', "Complete the authentication in the browser window that has opened."),
		});

		// Wait for the authorization code via a redirect
		let code: string | undefined;
		try {
			const response = await raceCancellationError(promise, token);
			code = response.code;
		} catch (err) {
			if (isCancellationError(err)) {
				this._logger.info('Authorization code request was cancelled by the user.');
				throw err;
			}
			const detail = describeOAuthFailure(err, 'the redirect failed unexpectedly');
			this._logger.error(`Failed to receive authorization code: ${detail}`);
			throw new OAuthSafeError(`Failed to receive authorization code: ${detail}`);
		}
		this._logger.info(`Authorization code received for ${scopeCountText(scopes)}`);

		// Exchange the authorization code for tokens
		const tokenResponse = await this.exchangeCodeForToken(code, codeVerifier, redirectUri);
		return tokenResponse;
	}

	protected generateRandomString(length: number): string {
		const array = new Uint8Array(length);
		crypto.getRandomValues(array);
		return Array.from(array)
			.map(b => b.toString(16).padStart(2, '0'))
			.join('')
			.substring(0, length);
	}

	protected async generateCodeChallenge(codeVerifier: string): Promise<string> {
		const encoder = new TextEncoder();
		const data = encoder.encode(codeVerifier);
		const digest = await crypto.subtle.digest('SHA-256', data);

		// Base64url encode the digest
		return encodeBase64(VSBuffer.wrap(new Uint8Array(digest)), false, false)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/, '');
	}

	private async waitForAuthorizationCode(expectedState: URI): Promise<{ code: string }> {
		let result: UriComponents;
		try {
			result = await this._proxy.$waitForUriHandler(expectedState);
		} catch (err) {
			if (isCancellationError(err)) {
				// A received cancellation is recognised by name and message only: its stack and properties are not trusted, so it is replaced
				throw new CancellationError();
			}
			// The error comes from another process and its text is not trusted: report a new error
			throw new OAuthSafeError('Failed to wait for the authorization redirect');
		}
		// Extract the code parameter directly from the query string. NOTE, URLSearchParams does not work here because
		// it will decode the query string and we need to keep it encoded.
		const codeMatch = /[?&]code=([^&]+)/.exec(result.query || '');
		if (!codeMatch || codeMatch.length < 2) {
			// No code parameter found in the query string
			throw new OAuthSafeError('Authentication failed: No authorization code received');
		}
		return { code: codeMatch[1] };
	}

	protected async exchangeCodeForToken(code: string, codeVerifier: string, redirectUri: string): Promise<IAuthorizationTokenResponse> {
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}

		const tokenRequest = new URLSearchParams();
		tokenRequest.append('client_id', this._clientId);
		tokenRequest.append('grant_type', 'authorization_code');
		tokenRequest.append('code', code);
		tokenRequest.append('redirect_uri', redirectUri);
		tokenRequest.append('code_verifier', codeVerifier);

		// Add resource indicator if available (RFC 8707)
		if (this._resourceMetadata?.resource) {
			tokenRequest.append('resource', this._resourceMetadata.resource);
		}

		// Add client secret if available
		if (this._clientSecret) {
			tokenRequest.append('client_secret', this._clientSecret);
		}

		this._logger.info('Exchanging authorization code for token...');
		this._logger.trace('Posting the token request to the token endpoint');
		let response: Response;
		try {
			response = await fetch(this._serverMetadata.token_endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json'
				},
				body: tokenRequest.toString()
			});
		} catch {
			// The transport error quotes the endpoint URL, which can hold credentials: report a new error without it
			const error = createOAuthTransportError('Token exchange');
			this._logger.error(describeOAuthFailure(error, 'the request failed unexpectedly'));
			throw error;
		}

		if (!response.ok && await this._isInvalidClientResponse(response)) {
			this._logger.warn(`Client ID (${this._clientId}) was rejected as invalid; the stored client registration is kept.`);
			throw new DynamicAuthClientRejectedError(this._errorLabel);
		}
		if (!response.ok) {
			// Status and a vetted OAuth error code only: the body can hold credentials
			throw await createOAuthHttpError('Token exchange', response);
		}

		const result = await readOAuthJsonResponse(response, 'Token exchange');
		if (isValidAuthorizationTokenResponse(result)) {
			this._logger.info(`Successfully exchanged authorization code for token.`);
			return result;
		} else if (isAuthorizationErrorResponse(result) && result.error === AuthorizationErrorType.InvalidClient) {
			this._logger.warn(`Client ID (${this._clientId}) was rejected as invalid; the stored client registration is kept.`);
			throw new DynamicAuthClientRejectedError(this._errorLabel);
		}
		throw createOAuthInvalidResponseError('authorization token', response, result);
	}

	/**
	 * Whether an unsuccessful response is the OAuth error `invalid_client` (RFC 6749 section 5.2), which servers send with
	 * HTTP 400 or 401. It reads a clone, so the caller can still read the response, and it logs nothing of the body.
	 * The clone is read by {@link readOAuthErrorBody}, which keeps no part of a read or parser error (either can quote a
	 * credential): a body that cannot be read or is not JSON is not `invalid_client`, and the caller's own reading of the
	 * response names that outcome in its failure.
	 */
	protected async _isInvalidClientResponse(response: Response): Promise<boolean> {
		const outcome = await readOAuthErrorBody(response.clone());
		return outcome.kind === 'json' && isAuthorizationErrorResponse(outcome.body) && outcome.body.error === AuthorizationErrorType.InvalidClient;
	}

	protected async exchangeRefreshTokenForToken(refreshToken: string): Promise<IAuthorizationToken> {
		if (!this._serverMetadata.token_endpoint) {
			throw new Error('Token endpoint not available in server metadata');
		}

		const tokenRequest = new URLSearchParams();
		tokenRequest.append('client_id', this._clientId);
		tokenRequest.append('grant_type', 'refresh_token');
		tokenRequest.append('refresh_token', refreshToken);

		// Add resource indicator if available (RFC 8707)
		if (this._resourceMetadata?.resource) {
			tokenRequest.append('resource', this._resourceMetadata.resource);
		}

		// Add client secret if available
		if (this._clientSecret) {
			tokenRequest.append('client_secret', this._clientSecret);
		}

		let response: Response;
		try {
			response = await fetch(this._serverMetadata.token_endpoint, {
				method: 'POST',
				headers: {
					'Content-Type': 'application/x-www-form-urlencoded',
					'Accept': 'application/json'
				},
				body: tokenRequest.toString()
			});
		} catch {
			// The transport error quotes the endpoint URL, which can hold credentials: report a new error without it
			throw createOAuthTransportError('Token refresh');
		}

		let result: unknown;
		let failure: OAuthBodyOutcome | undefined;
		if (response.ok) {
			result = await readOAuthJsonResponse(response, 'Token refresh');
			if (isValidAuthorizationTokenResponse(result)) {
				return {
					...result,
					created_at: Date.now(),
				};
			}
		} else {
			// A non-ok response is a failure. Its body is read only to find the invalid_client error that the
			// existing recovery below acts on, and to name a vetted error code. It is never put in a message.
			failure = await readOAuthErrorBody(response);
			if (failure.kind === 'json') {
				result = failure.body;
			}
		}
		if (isAuthorizationErrorResponse(result) && result.error === AuthorizationErrorType.InvalidClient) {
			this._logger.warn(`Client ID (${this._clientId}) was rejected as invalid; the stored client registration is kept.`);
			throw new DynamicAuthClientRejectedError(this._errorLabel);
		}
		if (failure) {
			throw new OAuthSafeError(formatOAuthHttpFailure('Token refresh', response, failure));
		}
		throw createOAuthInvalidResponseError('authorization token', response, result);
	}

	/**
	 * Obtains a new client registration and adopts it. It is saved (awaited) before it is used: a save that rejects rejects
	 * this call and the client ID and secret in use stay the previous ones. {@link onDidChangeClientId} only notifies, after.
	 */
	protected async _generateNewClientId(): Promise<void> {
		const { clientId, clientSecret } = await this._fetchNewClientRegistration();
		// Outside the registration-to-prompt fallback: a failed save is not a failed registration and prompts nobody.
		await this._proxy.$sendDidChangeDynamicProviderInfo({ providerId: this.id, clientId, clientSecret });
		this._clientId = clientId;
		this._clientSecret = clientSecret;
		this._onDidChangeClientId.fire();
	}

	/** Dynamic client registration; when it fails, the user is prompted for a client ID and client secret. Saves nothing. */
	private async _fetchNewClientRegistration(): Promise<{ clientId: string; clientSecret: string | undefined }> {
		let registration: { client_id: string; client_secret?: string };
		try {
			registration = await fetchDynamicRegistration(this._serverMetadata, this._initData.environment.appName, this._resourceMetadata?.scopes_supported);
		} catch (err) {
			// When DCR fails, try to prompt the user for a client ID and client secret
			// The issuer string is supplied by the server and can carry credentials: it is not logged
			const registrationFailure = describeOAuthFailure(err, 'the registration request failed unexpectedly');
			this._logger.info(`Dynamic registration failed: ${registrationFailure}. Prompting user for client ID and client secret.`);

			try {
				const clientDetails = await this._proxy.$promptForClientRegistration(this.authorizationServer.toString());
				if (!clientDetails) {
					throw new Error('User did not provide client details');
				}
				this._logger.info('User provided client ID');
				if (clientDetails.clientSecret) {
					this._logger.info('User provided client secret');
				} else {
					this._logger.info('User did not provide client secret (optional)');
				}
				return { clientId: clientDetails.clientId, clientSecret: clientDetails.clientSecret };
			} catch (promptErr) {
				this._logger.error(`Failed to fetch new client ID and user did not provide one: ${registrationFailure}`);
				throw new OAuthSafeError(`Failed to fetch new client ID and user did not provide one: ${registrationFailure}`);
			}
		}
		return { clientId: registration.client_id, clientSecret: registration.client_secret };
	}
}

type IAuthorizationToken = IAuthorizationTokenResponse & {
	/**
	 * The time when the token was created, in milliseconds since the epoch.
	 */
	created_at: number;
};

/**
 * A token as {@link TokenStore} keeps it. `session_id` names the logical session: it is made at sign-in and kept by every
 * refresh, so a session is never identified by its access token (a refresh replaces it) or by a hash of it (which can
 * collide). `revision` names this credential of the session: every sign-in and every refresh makes a new one. Both are
 * stored beside the token.
 */
type ISessionToken = IAuthorizationToken & {
	session_id: string;
	revision: string;
};

/**
 * Stored on each token of a saved list (the same on every token of it): the revisions of the stored list that this list
 * includes, newest first, its own first. A window tells from them whether a list it reads was written with its own last
 * save in view, and which earlier list both include.
 */
const STORED_REVISIONS = 'stored_revisions';
/**
 * Stored on each token of a saved list (the same on every token of it): the ids of sessions recently signed out, newest
 * first. A list that still holds such a session (written without the sign-out in view) is corrected by every window that
 * knows of the sign-out. An empty list cannot carry it: a window that saw the sign-out keeps it in memory as well.
 */
const SIGNED_OUT_SESSIONS = 'signed_out_sessions';
/**
 * An empty list is stored as one record that is not a session (it marks itself with this key, holds no credential, and has
 * the shape of a stored token response so that the stored value stays a list of them): it carries the bookkeeping that the
 * tokens of a non-empty list carry, so an empty list merges like any other.
 */
const SESSION_LIST_RECORD = 'session_list_record';
const STORED_REVISIONS_MAX = 32;
const SIGNED_OUT_SESSIONS_MAX = 32;
const REMEMBERED_LISTS_MAX = 32;
/** Saves of one operation while the stored sessions keep changing, before it rejects. */
const SAVE_ROUNDS_MAX = 5;

/** A list of sessions as stored. */
interface ISessionList {
	readonly tokens: readonly ISessionToken[];
	/**
	 * Its stored revisions, newest first. A list saved by an earlier version (no bookkeeping: an unversioned base) has
	 * one revision derived from its content, so every window that reads it derives the same.
	 */
	readonly revisions: readonly string[];
	/** The ids of sessions recently signed out, newest first. */
	readonly signedOut: readonly string[];
}

/** The stored sessions cannot be read as sessions: the stored value is kept and not used. The message carries no token. */
class InvalidStoredSessionsError extends Error {
	override readonly name = 'InvalidStoredSessionsError';
}

function newRevision(): string {
	return generateUuid().replace(/-/g, '').slice(0, 16);
}

/**
 * The session id and revision of a token saved by an earlier version, which stored neither: derived from its whole access
 * token, so every window derives the same, and two tokens never share one (a SHA-1, not a 32-bit hash). It reveals no token.
 */
function legacySessionId(token: IAuthorizationToken): string {
	const sha = new StringSHA1();
	sha.update(token.access_token);
	return `legacy-${sha.digest()}`;
}

function isStringList(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/** The first `max` distinct items of the lists, in order. */
function newestFirst(max: number, ...lists: (readonly string[])[]): string[] {
	return [...new Set(lists.flat())].slice(0, max);
}

/**
 * Reads a stored list. Rejects with {@link InvalidStoredSessionsError} when its session bookkeeping is malformed. A list
 * saved by an earlier version (bare tokens, no bookkeeping) is an unversioned base: its sessions get ids derived from
 * their access tokens, it gets one revision derived from them, and it records no sign-out.
 */
function readSessionList(stored: readonly IAuthorizationToken[]): ISessionList {
	const tokens: ISessionToken[] = [];
	let lists: { revisions: string[]; signedOut: string[] } | undefined;
	let unversioned = 0;
	for (const entry of stored) {
		const { [STORED_REVISIONS]: revisions, [SIGNED_OUT_SESSIONS]: signedOut, [SESSION_LIST_RECORD]: listRecord, ...token } = entry as IAuthorizationToken & { session_id?: unknown; revision?: unknown; [STORED_REVISIONS]?: unknown; [SIGNED_OUT_SESSIONS]?: unknown; [SESSION_LIST_RECORD]?: unknown };
		if (token.session_id === undefined && token.revision === undefined && revisions === undefined && signedOut === undefined && listRecord === undefined) {
			const id = legacySessionId(entry);
			tokens.push({ ...token, session_id: id, revision: id });
			unversioned++;
			continue;
		}
		if (!isStringList(revisions) || !revisions.length || !isStringList(signedOut)) {
			throw new InvalidStoredSessionsError('A stored session has malformed session bookkeeping.');
		}
		if (!lists) {
			lists = { revisions, signedOut };
		} else if (!arraysEqual(lists.revisions, revisions) || !arraysEqual(lists.signedOut, signedOut)) {
			throw new InvalidStoredSessionsError('The stored sessions disagree on the bookkeeping of their list.');
		}
		if (listRecord !== undefined) {
			if (listRecord !== true || stored.length !== 1 || token.access_token !== '') {
				throw new InvalidStoredSessionsError('The record of an empty session list is malformed or not alone.');
			}
			continue;
		}
		if (typeof token.session_id !== 'string' || typeof token.revision !== 'string') {
			throw new InvalidStoredSessionsError('A stored session has malformed session bookkeeping.');
		}
		tokens.push({ ...token, session_id: token.session_id, revision: token.revision });
	}
	if (unversioned && lists) {
		throw new InvalidStoredSessionsError('The stored sessions mix sessions with and without bookkeeping.');
	}
	if (new Set(tokens.map(t => t.session_id)).size !== tokens.length) {
		throw new InvalidStoredSessionsError('Two stored sessions share a session id.');
	}
	if (!lists) {
		const sha = new StringSHA1();
		sha.update(tokens.map(t => t.session_id).sort().join(' '));
		return { tokens, revisions: [`legacy-${sha.digest()}`], signedOut: [] };
	}
	return { tokens, revisions: lists.revisions, signedOut: lists.signedOut };
}

/** Whether two lists hold the same credentials: the same sessions, each at the same revision. */
function sameSessions(a: readonly ISessionToken[], b: readonly ISessionToken[]): boolean {
	return a.length === b.length && a.every(token => b.some(other => other.session_id === token.session_id && other.revision === token.revision));
}

/**
 * Merges a list stored by another window (`theirs`) with this window's sessions (`ours`), both changed since `base`
 * (a list each of them includes). A signed-out session is dropped from every side. Per logical session, a change on one
 * side only is taken. Changed on both sides: a sign-out wins over a refresh (it is the user's explicit act), and two
 * refreshes are both kept (no credential another window saved is lost, and none made here). Which of the two keeps the
 * session id and which becomes a session of its own (its id: its revision) is decided by revision alone, so every window
 * that merges the same two decides the same. Returns the merged sessions and the ids of the sessions it found signed out.
 */
function mergeSessions(base: readonly ISessionToken[], theirs: readonly ISessionToken[], ours: readonly ISessionToken[], signedOut: ReadonlySet<string>, logger: ILogger): { tokens: ISessionToken[]; signedOut: string[] } {
	const live = (tokens: readonly ISessionToken[]) => new Map(tokens.filter(t => !signedOut.has(t.session_id)).map(t => [t.session_id, t]));
	const b = live(base), t = live(theirs), o = live(ours);
	if (ours.some(token => signedOut.has(token.session_id))) {
		logger.warn('A session held here was signed out in another window; it stays signed out.');
	}
	const merged = new Map<string, ISessionToken>();
	const forks: ISessionToken[] = [];
	const removed: string[] = [];
	for (const id of new Set([...t.keys(), ...o.keys(), ...b.keys()])) {
		const ancestor = b.get(id)?.revision, mine = o.get(id), other = t.get(id);
		let kept: ISessionToken | undefined;
		if (other?.revision === mine?.revision || mine?.revision === ancestor) {
			kept = other;
		} else if (other?.revision === ancestor) {
			kept = mine;
		} else if (!other || !mine) {
			logger.warn(other
				? 'A session signed out here was refreshed in another window; it stays signed out.'
				: 'A session refreshed here was signed out in another window; it stays signed out and the refreshed credential is not kept.');
		} else {
			const [winner, forked] = other.revision < mine.revision ? [other, mine] : [mine, other];
			kept = winner;
			forks.push({ ...forked, session_id: forked.revision });
			logger.warn('A session was refreshed both here and in another window; both credentials are kept, as two sessions.');
		}
		if (kept) {
			merged.set(id, kept);
		} else {
			removed.push(id);
		}
	}
	for (const fork of forks) {
		// The other side may hold the same fork already.
		if (!merged.has(fork.session_id)) {
			merged.set(fork.session_id, fork);
		}
	}
	return { tokens: [...merged.values()], signedOut: removed };
}

/**
 * The sessions of one dynamic provider and client, shared with every other window through secret storage. Each window
 * keeps the sessions it uses ({@link tokens}): the stored ones merged with every change it saw or made. A save writes
 * them with the revisions of the stored lists they include and the sessions recently signed out; a list another window
 * stores is merged against the last list both include ({@link mergeSessions}), so a save that lands over another
 * window's never decides the outcome: a window whose change is missing from a stored list saves the merged sessions again.
 *
 * Every saved list carries this bookkeeping, an empty one included ({@link SESSION_LIST_RECORD}). A list that shares
 * no remembered revision with the sessions here (an unversioned list of an earlier version that this window did not
 * start from, or one whose common revisions were forgotten) is merged against no common list: nothing here is dropped
 * by it, only a sign-out it records removes a session, and two credentials of one session are both kept.
 *
 * Residual (R-104, named; a later fold adds a main-process store with a conditional write): there is no compare-and-set
 * at the storage boundary. Each renderer writes its own cached copy of application storage and flushes it to the main
 * process about 100 ms later (base/parts/storage/common/storage.ts, DEFAULT_FLUSH_DELAY), where the last write wins.
 * Window A saves a session N; window B, which has not read A's list yet, saves a list without N; B's write reaches the
 * main process after A's. While A is open it reads B's list, finds N missing and saves the merged list again (the
 * repair). If A closes before reading it, N is lost.
 */
class TokenStore implements Disposable {
	/** The sessions this window uses. They may hold a change that is not saved yet. */
	private _tokens: ISessionToken[];
	/** The stored revisions whose lists {@link _tokens} includes, newest first. */
	private _revisions: string[];
	/** The ids of sessions signed out (here, or seen signed out), newest first. */
	private _signedOut: string[];
	/** The last list known to be stored: read from storage, or saved here with nothing read meanwhile. */
	private _stored: ISessionList;
	/** Lists by stored revision, read or saved here: the merge base for a list another window stores. */
	private readonly _lists = new Map<string, readonly ISessionToken[]>();
	/** Counts the lists read from storage, so that a save tells whether one was read while it ran. */
	private _reads = 0;
	private _saving = false;
	private readonly _saves = new Sequencer();
	/** The tokens known to be saved: completed-change events are published from these only. */
	private readonly _tokensObservable: ISettableObservable<readonly ISessionToken[]>;
	private readonly _sessionsObservable: IObservable<vscode.AuthenticationSession[]>;

	private readonly _onDidChangeSessions = new Emitter<vscode.AuthenticationProviderAuthenticationSessionsChangeEvent>();
	readonly onDidChangeSessions = this._onDidChangeSessions.event;

	private readonly _disposable: DisposableStore;

	constructor(
		private readonly _persistence: { onDidChange: Event<IAuthorizationToken[] | undefined>; set: (tokens: IAuthorizationToken[]) => Promise<void> },
		initialTokens: IAuthorizationToken[],
		private readonly _logger: ILogger
	) {
		this._disposable = new DisposableStore();
		const initial = readSessionList(initialTokens);
		this._tokens = [...initial.tokens];
		this._revisions = [...initial.revisions];
		this._signedOut = [...initial.signedOut];
		this._stored = initial;
		this._remember(initial);
		this._tokensObservable = observableValue<readonly ISessionToken[]>('tokens', initial.tokens);
		this._sessionsObservable = derivedOpts(
			{ equalsFn: (a, b) => arraysEqual(a, b, (a, b) => a.accessToken === b.accessToken) },
			(reader) => this._tokensObservable.read(reader).map(t => this._getSessionFromToken(t))
		);
		this._disposable.add(this._registerChangeEventAutorun());
		this._disposable.add(this._persistence.onDidChange(tokens => this._onDidStore(tokens)));
	}

	get tokens(): ISessionToken[] {
		return this._tokens;
	}

	get sessions(): vscode.AuthenticationSession[] {
		return this._tokens.map(t => this._getSessionFromToken(t));
	}

	dispose() {
		this._disposable.dispose();
	}

	/** A list was stored (by any window, this one included): it is merged into the sessions here. */
	private _onDidStore(stored: IAuthorizationToken[] | undefined): void {
		let list: ISessionList;
		try {
			// The storage reports a deleted list as undefined. Only removing the provider deletes it: it holds no session.
			list = readSessionList(stored === undefined ? [] : stored);
		} catch (error) {
			if (!(error instanceof InvalidStoredSessionsError)) {
				throw error;
			}
			this._logger.error(`The stored sessions changed but cannot be read: ${error.message} They are not used here.`);
			return;
		}
		this._reads++;
		const signedOut = new Set([...this._signedOut, ...list.signedOut]);
		const merged = mergeSessions(this._mergeBase(list), list.tokens, this._tokens, signedOut, this._logger);
		this._tokens = merged.tokens;
		this._signedOut = newestFirst(SIGNED_OUT_SESSIONS_MAX, merged.signedOut, list.signedOut, this._signedOut);
		this._revisions = newestFirst(STORED_REVISIONS_MAX, list.revisions, this._revisions);
		this._remember(list);
		this._stored = list;
		this._tokensObservable.set(list.tokens, undefined);
		if (!this._saving && !sameSessions(this._tokens, list.tokens)) {
			// A change made here and not saved yet, or one that a save of another window overwrote.
			this._logger.info('The stored sessions lack a change known here; the merged sessions are saved.');
			this.savePending().then(undefined, () => {
				this._logger.error('The merged sessions could not be saved; the change is kept here and saved by the next operation.');
			});
		}
	}

	/** The last list that both a stored list and the sessions here include. */
	private _mergeBase(list: ISessionList): readonly ISessionToken[] {
		for (const revision of list.revisions) {
			const known = this._revisions.includes(revision) ? this._lists.get(revision) : undefined;
			if (known) {
				return known;
			}
		}
		// No list known to both: nothing here is taken as removed by it (see the class comment).
		this._logger.warn('The stored sessions share no known list with the sessions here; they are merged without dropping any session.');
		return [];
	}

	private _remember(list: ISessionList): void {
		this._lists.set(list.revisions[0], list.tokens);
		for (const revision of this._lists.keys()) {
			if (this._lists.size <= REMEMBERED_LISTS_MAX) {
				break;
			}
			this._lists.delete(revision);
		}
	}

	/**
	 * Applies the change here and saves it. When it cannot be saved this rejects with {@link DynamicAuthSessionPersistError}
	 * (after one error line) and the change stays pending: {@link savePending} saves it before a later operation succeeds.
	 * A refresh replaces the credential of its session only if it is still the one refreshed: a session another window
	 * refreshed meanwhile keeps that credential and the new one becomes a session of its own; a session signed out
	 * meanwhile stays signed out.
	 */
	async update({ added = [], refreshed = [], removed = [] }: {
		added?: readonly IAuthorizationToken[];
		refreshed?: readonly { previous: ISessionToken; token: IAuthorizationToken }[];
		removed?: readonly ISessionToken[];
	}): Promise<void> {
		this._logger.trace(`Updating tokens: added ${added.length + refreshed.length}, removed ${refreshed.length + removed.length}`);
		let tokens = [...this._tokens];
		for (const { previous, token } of refreshed) {
			const index = tokens.findIndex(t => t.session_id === previous.session_id);
			if (index === -1) {
				this._logger.warn('A session refreshed here was signed out meanwhile; it stays signed out and the refreshed credential is not kept.');
			} else if (tokens[index].revision !== previous.revision) {
				// The other window's credential is stored already: it keeps the session id, and this one is a session of its own.
				this._logger.warn('A session was refreshed both here and in another window; both credentials are kept, as two sessions.');
				const revision = newRevision();
				tokens.push({ ...token, session_id: revision, revision });
			} else {
				tokens[index] = { ...token, session_id: previous.session_id, revision: newRevision() };
			}
		}
		for (const token of added) {
			tokens.push({ ...token, session_id: newRevision(), revision: newRevision() });
		}
		if (removed.length) {
			const ids = removed.map(token => token.session_id);
			tokens = tokens.filter(t => !ids.includes(t.session_id));
			this._signedOut = newestFirst(SIGNED_OUT_SESSIONS_MAX, ids, this._signedOut);
		}
		this._tokens = tokens;
		await this.savePending();
		this._logger.trace(`Tokens updated: ${tokens.length} tokens stored.`);
	}

	/**
	 * Saves a change that is not saved yet; nothing to do otherwise. Once saved, the completed-change event is published.
	 * Rejects with {@link DynamicAuthSessionPersistError} after one error line, leaving the change pending. Saves are
	 * serialized; a list stored by another window while a save runs is merged, and the merged sessions are saved again.
	 */
	savePending(): Promise<void> {
		return this._saves.queue(() => this._saveRounds());
	}

	private async _saveRounds(): Promise<void> {
		this._saving = true;
		try {
			for (let round = 1; !sameSessions(this._tokens, this._stored.tokens); round++) {
				if (round > SAVE_ROUNDS_MAX) {
					this._logger.error(`The stored sessions kept changing while ${this._tokens.length} token(s) were saved; the change is kept here and saved by the next operation.`);
					throw new DynamicAuthSessionPersistError(this._tokens.length, 'ConcurrentChange');
				}
				if (round > 1) {
					this._logger.warn('The sessions changed while they were saved; the merged sessions are saved again.');
				}
				await this._saveOnce();
			}
		} finally {
			this._saving = false;
		}
	}

	private async _saveOnce(): Promise<void> {
		const tokens = this._tokens;
		const revisions = newestFirst(STORED_REVISIONS_MAX, [newRevision()], this._revisions);
		const signedOut = this._signedOut;
		this._revisions = revisions;
		const list: ISessionList = { tokens, revisions, signedOut };
		this._remember(list);
		const reads = this._reads;
		const bookkeeping = { [STORED_REVISIONS]: revisions, [SIGNED_OUT_SESSIONS]: signedOut };
		const stored: IAuthorizationToken[] = tokens.length
			? tokens.map(token => Object.assign({}, token, bookkeeping))
			: [Object.assign({ access_token: '', token_type: SESSION_LIST_RECORD, created_at: 0, [SESSION_LIST_RECORD]: true }, bookkeeping)];
		try {
			await this._persistence.set(stored);
		} catch (error) {
			// The tokens are credentials, and a storage error's text is not safe by construction: only the count and the
			// error's class are logged and carried (no cause).
			const failure = error instanceof Error ? error.name : typeof error;
			this._logger.error(`Failed to save ${tokens.length} token(s) to secret storage: ${failure}`);
			throw new DynamicAuthSessionPersistError(tokens.length, failure);
		}
		if (this._reads === reads) {
			// Nothing was read while saving: the saved list is the stored one. Otherwise the last list read is the one
			// compared with, and the merged sessions are saved again if they differ.
			this._stored = list;
			this._tokensObservable.set(tokens, undefined);
		}
	}

	private _registerChangeEventAutorun(): IDisposable {
		let previousSessions: vscode.AuthenticationSession[] = [];
		return autorun((reader) => {
			this._logger.trace('Checking for session changes...');
			const currentSessions = this._sessionsObservable.read(reader);
			if (previousSessions === currentSessions) {
				this._logger.trace('No session changes detected.');
				return;
			}

			if (!currentSessions || currentSessions.length === 0) {
				// If currentSessions is undefined, all previous sessions are considered removed
				this._logger.trace('All sessions removed.');
				if (previousSessions.length > 0) {
					this._onDidChangeSessions.fire({
						added: [],
						removed: previousSessions,
						changed: []
					});
					previousSessions = [];
				}
				return;
			}

			const added: vscode.AuthenticationSession[] = [];
			const removed: vscode.AuthenticationSession[] = [];

			// Find added sessions
			for (const current of currentSessions) {
				const exists = previousSessions.some(prev => prev.accessToken === current.accessToken);
				if (!exists) {
					added.push(current);
				}
			}

			// Find removed sessions
			for (const prev of previousSessions) {
				const exists = currentSessions.some(current => current.accessToken === prev.accessToken);
				if (!exists) {
					removed.push(prev);
				}
			}

			// Fire the event if there are any changes
			if (added.length > 0 || removed.length > 0) {
				this._logger.trace(`Sessions changed: added ${added.length}, removed ${removed.length}`);
				this._onDidChangeSessions.fire({ added, removed, changed: [] });
			}

			// Update previous sessions reference
			previousSessions = currentSessions;
		});
	}

	private _getSessionFromToken(token: ISessionToken): vscode.AuthenticationSession {
		let claims: IAuthorizationJWTClaims | undefined;
		if (token.id_token) {
			try {
				claims = getClaimsFromJWT(token.id_token);
			} catch (e) {
				// log
			}
		}
		if (!claims) {
			try {
				claims = getClaimsFromJWT(token.access_token);
			} catch (e) {
				// log
			}
		}
		const scopes = token.scope
			? token.scope.split(' ')
			: claims?.scope
				? claims.scope.split(' ')
				: [];
		return {
			// The credential's revision: unique, free of token text, and new at each refresh (as the access token is).
			id: token.revision,
			accessToken: token.access_token,
			account: {
				id: claims?.sub || 'unknown',
				// TODO: Don't say MCP...
				label: claims?.preferred_username || claims?.name || claims?.email || 'MCP',
			},
			scopes: scopes,
			idToken: token.id_token
		};
	}
}
