/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderInfo, DynamicAuthenticationProviderTokensChangeEvent } from '../common/dynamicAuthenticationProviderStorage.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IAuthorizationTokenResponse, isAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Queue } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';

/**
 * Why a stored provider list is invalid: `reason` is the stable English structural form (key metadata and
 * log line), `localizedReason` the same text for the user. Both name only structure (index, field, JSON
 * type, parse error class), never a stored value.
 */
interface InvalidStoredProviderListReason {
	readonly reason: string;
	readonly localizedReason: string;
}

const invalidStoredProviderListReasons = {
	notJson: (errorClass: string): InvalidStoredProviderListReason => ({
		reason: `not valid JSON (${errorClass})`,
		localizedReason: localize('dynamicAuthProviders.invalidList.notJson', "not valid JSON ({0})", errorClass),
	}),
	notArray: (valueType: string): InvalidStoredProviderListReason => ({
		reason: `not an array (${valueType})`,
		localizedReason: localize('dynamicAuthProviders.invalidList.notArray', "not an array ({0})", valueType),
	}),
	entryNotObject: (index: number, valueType: string): InvalidStoredProviderListReason => ({
		reason: `entry ${index} is not an object (${valueType})`,
		localizedReason: localize('dynamicAuthProviders.invalidList.entryNotObject', "entry {0} is not an object ({1})", index, valueType),
	}),
	fieldNotString: (index: number, field: string, valueType: string): InvalidStoredProviderListReason => ({
		reason: `entry ${index} field ${field} is not a string (${valueType})`,
		localizedReason: localize({ key: 'dynamicAuthProviders.invalidList.fieldNotString', comment: ['{1} is a field name such as clientId and is not translated'] }, "entry {0} field {1} is not a string ({2})", index, field, valueType),
	}),
	noAuthorizationServer: (index: number): InvalidStoredProviderListReason => ({
		reason: `entry ${index} has no authorizationServer and no legacy issuer`,
		localizedReason: localize({ key: 'dynamicAuthProviders.invalidList.noAuthorizationServer', comment: ['authorizationServer and issuer are field names and are not translated'] }, "entry {0} has no authorizationServer and no legacy issuer", index),
	}),
};

/**
 * The stored dynamic authentication provider list is present but unreadable. Carries the storage key and a
 * stable structural reason; its message is localized. Never carries the stored text.
 */
export class InvalidStoredProviderListError extends Error {
	readonly reason: string;
	constructor(readonly storageKey: string, reason: InvalidStoredProviderListReason) {
		super(localize('dynamicAuthProviders.invalidList', "Stored dynamic authentication provider list '{0}' is invalid: {1}. It was left unchanged.", storageKey, reason.localizedReason));
		this.name = 'InvalidStoredProviderListError';
		this.reason = reason.reason;
	}
}

/** A stored entry after validation and before the issuer migration. */
type StoredProviderInfo = { providerId: string; clientId: string; label: string; authorizationServer?: string; issuer?: string };

const REQUIRED_STRING_FIELDS = ['providerId', 'clientId', 'label'] as const;
const OPTIONAL_STRING_FIELDS = ['authorizationServer', 'issuer'] as const;

/** The JSON type of a stored value, for a diagnostic; never the value itself. */
function describeType(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	return Array.isArray(value) ? 'array' : typeof value;
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
			try {
				const credentials = JSON.parse(credentialsValue);
				if (credentials && (credentials.clientId || credentials.clientSecret)) {
					return credentials;
				}
			} catch {
				await this.secretStorageService.delete(key);
			}
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
	 * JSON, not an array, or holds an entry that is not a {@link DynamicAuthenticationProviderInfo} (an object
	 * with string `providerId`, `clientId` and `label`, an optional string `authorizationServer` and `issuer`,
	 * and a non-empty `authorizationServer` or, in the legacy form the migration below reads, a string `issuer`)
	 * is logged (key and structural reason only, never the stored text) and thrown as
	 * {@link InvalidStoredProviderListError}, so no caller can write a replacement list over it.
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
			throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.notJson(errorClass));
		}

		if (!Array.isArray(parsed)) {
			throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.notArray(describeType(parsed)));
		}

		const providerInfos: StoredProviderInfo[] = [];
		for (let index = 0; index < parsed.length; index++) {
			const entry: unknown = parsed[index];
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
				throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.entryNotObject(index, describeType(entry)));
			}
			const fields = entry as Record<string, unknown>;
			for (const field of REQUIRED_STRING_FIELDS) {
				if (typeof fields[field] !== 'string') {
					throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.fieldNotString(index, field, describeType(fields[field])));
				}
			}
			for (const field of OPTIONAL_STRING_FIELDS) {
				if (fields[field] !== undefined && typeof fields[field] !== 'string') {
					throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.fieldNotString(index, field, describeType(fields[field])));
				}
			}
			// The migration below replaces an empty or absent authorizationServer with the legacy issuer.
			if (!fields.authorizationServer && typeof fields.issuer !== 'string') {
				throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.noAuthorizationServer(index));
			}
			providerInfos.push(entry as StoredProviderInfo);
		}

		// MIGRATION: remove after an iteration or 2
		for (const providerInfo of providerInfos) {
			if (!providerInfo.authorizationServer) {
				providerInfo.authorizationServer = providerInfo.issuer;
			}
		}
		return providerInfos as DynamicAuthenticationProviderInfo[];
	}

	private _invalidStoredProviders(storageKey: string, reason: InvalidStoredProviderListReason): InvalidStoredProviderListError {
		const error = new InvalidStoredProviderListError(storageKey, reason);
		// Logs stay in English whatever the display language: the stable reason, not the localized message.
		this.logService.error(`${error.name}: stored dynamic authentication provider list '${storageKey}' is invalid: ${error.reason}. It was left unchanged.`);
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
			const parsed = JSON.parse(value);
			if (!Array.isArray(parsed) || !parsed.every((t) => typeof t.created_at === 'number' && isAuthorizationTokenResponse(t))) {
				this.logService.error(`Invalid session data for ${authProviderId} (${clientId}) in secret storage:`, parsed);
				await this.secretStorageService.delete(key);
				return undefined;
			}
			return parsed;
		}
		return undefined;
	}

	async setSessionsForDynamicAuthProvider(authProviderId: string, clientId: string, sessions: (IAuthorizationTokenResponse & { created_at: number })[]): Promise<void> {
		const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
		const value = JSON.stringify(sessions);
		await this.secretStorageService.set(key, value);
		this.logService.trace(`Set session data for ${authProviderId} (${clientId}) in secret storage:`, sessions);
	}
}

registerSingleton(IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderStorageService, InstantiationType.Delayed);
