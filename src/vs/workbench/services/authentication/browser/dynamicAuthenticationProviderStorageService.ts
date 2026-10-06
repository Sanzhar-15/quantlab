/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderInfo, DynamicAuthenticationProviderTokensChangeEvent } from '../common/dynamicAuthenticationProviderStorage.js';
import { InvalidStoredSecretError, ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IAuthorizationTokenResponse, isAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Queue } from '../../../../base/common/async.js';

/**
 * The stored dynamic authentication provider list is present but unreadable. Carries the storage key and a
 * reason; never the stored text.
 */
export class InvalidStoredProviderListError extends Error {
	constructor(readonly storageKey: string, readonly reason: string) {
		super(`Stored dynamic authentication provider list '${storageKey}' is invalid: ${reason}. It was left unchanged.`);
		this.name = 'InvalidStoredProviderListError';
	}
}

export class DynamicAuthenticationProviderStorageService extends Disposable implements IDynamicAuthenticationProviderStorageService {
	declare readonly _serviceBrand: undefined;

	private static readonly PROVIDERS_STORAGE_KEY = 'dynamicAuthProviders';

	private readonly _onDidChangeTokens = this._register(new Emitter<DynamicAuthenticationProviderTokensChangeEvent>());
	readonly onDidChangeTokens: Event<DynamicAuthenticationProviderTokensChangeEvent> = this._onDidChangeTokens.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Listen for secret storage changes and emit events for dynamic auth provider token changes
		const queue = new Queue<void>();
		this._register(this.secretStorageService.onDidChangeSecret(async (key: string) => {
			let payload: { isDynamicAuthProvider: boolean; authProviderId: string; clientId: string } | undefined;
			try {
				payload = JSON.parse(key);
			} catch (error) {
				// Ignore errors... must not be a dynamic auth provider
			}
			if (payload?.isDynamicAuthProvider) {
				void queue.queue(async () => {
					const tokens = await this.getSessionsForDynamicAuthProvider(payload.authProviderId, payload.clientId);
					this._onDidChangeTokens.fire({
						authProviderId: payload.authProviderId,
						clientId: payload.clientId,
						tokens
					});
				});
			}
		}));
	}

	async getClientRegistration(providerId: string): Promise<{ clientId?: string; clientSecret?: string } | undefined> {
		// First try new combined SecretStorage format
		const key = `dynamicAuthProvider:clientRegistration:${providerId}`;
		const credentialsValue = await this.secretStorageService.get(key);
		if (credentialsValue) {
			let credentials;
			try {
				credentials = JSON.parse(credentialsValue);
			} catch {
				// The parse error quotes the stored text, so it is not carried.
				throw new InvalidStoredSecretError(key, 'is not valid JSON');
			}
			if (!credentials || !(credentials.clientId || credentials.clientSecret)) {
				throw new InvalidStoredSecretError(key, 'has neither a client id nor a client secret');
			}
			return credentials;
		}

		// Just grab the client id from the provider
		const providers = this._getStoredProviders();
		const provider = providers.find(p => p.providerId === providerId);
		return provider?.clientId ? { clientId: provider.clientId } : undefined;
	}

	getClientId(providerId: string): string | undefined {
		// For backward compatibility, try old storage format first
		const providers = this._getStoredProviders();
		const provider = providers.find(p => p.providerId === providerId);
		return provider?.clientId;
	}

	async storeClientRegistration(providerId: string, authorizationServer: string, clientId: string, clientSecret?: string, label?: string): Promise<void> {
		// Store provider information for backward compatibility and UI display
		this._trackProvider(providerId, authorizationServer, clientId, label);

		// Store both client ID and secret together in SecretStorage
		const key = `dynamicAuthProvider:clientRegistration:${providerId}`;
		const credentials = { clientId, clientSecret };
		await this.secretStorageService.set(key, JSON.stringify(credentials));
	}

	private _trackProvider(providerId: string, authorizationServer: string, clientId: string, label?: string): void {
		const providers = this._getStoredProviders();

		// Check if provider already exists
		const existingProviderIndex = providers.findIndex(p => p.providerId === providerId);
		if (existingProviderIndex === -1) {
			// Add new provider with provided or default info
			const newProvider: DynamicAuthenticationProviderInfo = {
				providerId,
				label: label || providerId, // Use provided label or providerId as default
				authorizationServer,
				clientId
			};
			providers.push(newProvider);
			this._storeProviders(providers);
		} else {
			const existingProvider = providers[existingProviderIndex];
			// Create new provider object with updated info
			const updatedProvider: DynamicAuthenticationProviderInfo = {
				providerId,
				label: label || existingProvider.label,
				authorizationServer,
				clientId
			};
			providers[existingProviderIndex] = updatedProvider;
			this._storeProviders(providers);
		}
	}

	/**
	 * Reads the stored provider list. An absent key is a real empty list. A present value that is not
	 * JSON, not an array, or holds an entry that is not an object with a string `providerId` is logged
	 * (key and reason only, never the stored text) and thrown as {@link InvalidStoredProviderListError},
	 * so no caller can write a replacement list over it.
	 */
	private _getStoredProviders(): DynamicAuthenticationProviderInfo[] {
		const storageKey = DynamicAuthenticationProviderStorageService.PROVIDERS_STORAGE_KEY;
		const stored = this.storageService.get(storageKey, StorageScope.APPLICATION);
		if (stored === undefined) {
			return [];
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(stored);
		} catch (error) {
			// The parse message quotes its input, so only the error class is carried.
			const errorClass = error instanceof Error ? error.name : typeof error;
			throw this._invalidStoredProviders(storageKey, `not valid JSON (${errorClass})`);
		}

		if (!Array.isArray(parsed)) {
			throw this._invalidStoredProviders(storageKey, `not an array (${parsed === null ? 'null' : typeof parsed})`);
		}

		const providerInfos: { providerId: string; authorizationServer?: unknown; issuer?: unknown }[] = [];
		for (let index = 0; index < parsed.length; index++) {
			const entry: unknown = parsed[index];
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry) || typeof (entry as { providerId?: unknown }).providerId !== 'string') {
				throw this._invalidStoredProviders(storageKey, `entry ${index} is not an object with a string providerId`);
			}
			providerInfos.push(entry as { providerId: string; authorizationServer?: unknown; issuer?: unknown });
		}

		// MIGRATION: remove after an iteration or 2
		for (const providerInfo of providerInfos) {
			if (!providerInfo.authorizationServer) {
				providerInfo.authorizationServer = providerInfo.issuer;
			}
		}
		return providerInfos as DynamicAuthenticationProviderInfo[];
	}

	private _invalidStoredProviders(storageKey: string, reason: string): InvalidStoredProviderListError {
		const error = new InvalidStoredProviderListError(storageKey, reason);
		this.logService.error(error.message);
		return error;
	}

	private _storeProviders(providers: DynamicAuthenticationProviderInfo[]): void {
		this.storageService.store(
			DynamicAuthenticationProviderStorageService.PROVIDERS_STORAGE_KEY,
			JSON.stringify(providers),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE
		);
	}

	getInteractedProviders(): ReadonlyArray<DynamicAuthenticationProviderInfo> {
		return this._getStoredProviders();
	}

	async removeDynamicProvider(providerId: string): Promise<void> {
		// Get provider info before removal for secret cleanup
		const providers = this._getStoredProviders();
		const providerInfo = providers.find(p => p.providerId === providerId);

		// Remove from stored providers
		const filteredProviders = providers.filter(p => p.providerId !== providerId);
		this._storeProviders(filteredProviders);

		// Remove sessions from secret storage if we have the provider info
		if (providerInfo) {
			const secretKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: providerId, clientId: providerInfo.clientId });
			await this.secretStorageService.delete(secretKey);
		}

		// Remove client credentials from new SecretStorage format
		const credentialsKey = `dynamicAuthProvider:clientRegistration:${providerId}`;
		await this.secretStorageService.delete(credentialsKey);
	}

	async getSessionsForDynamicAuthProvider(authProviderId: string, clientId: string): Promise<(IAuthorizationTokenResponse & { created_at: number })[] | undefined> {
		const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
		const value = await this.secretStorageService.get(key);
		if (value) {
			let parsed;
			try {
				parsed = JSON.parse(value);
			} catch {
				// The parse error quotes the stored text, so it is not carried.
				throw new InvalidStoredSecretError(key, 'is not valid JSON');
			}
			if (!Array.isArray(parsed) || !parsed.every((t) => typeof t.created_at === 'number' && isAuthorizationTokenResponse(t))) {
				throw new InvalidStoredSecretError(key, `is not a list of token responses for ${authProviderId} (${clientId})`);
			}
			return parsed;
		}
		return undefined;
	}

	async setSessionsForDynamicAuthProvider(authProviderId: string, clientId: string, sessions: (IAuthorizationTokenResponse & { created_at: number })[]): Promise<void> {
		const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
		const value = JSON.stringify(sessions);
		await this.secretStorageService.set(key, value);
		// The token responses are credentials: only their count is logged.
		this.logService.trace(`Set ${sessions.length} session(s) for ${authProviderId} (${clientId}) in secret storage`);
	}
}

registerSingleton(IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderStorageService, InstantiationType.Delayed);
