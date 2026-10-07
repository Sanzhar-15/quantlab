/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderCleanupInfo, DynamicAuthenticationProviderInfo, DynamicAuthenticationProviderTokensChangeEvent } from '../common/dynamicAuthenticationProviderStorage.js';
import { InvalidStoredSecretError, ISecretStorageService, SecretDecryptionError, SecretStorageUnavailableError } from '../../../../platform/secrets/common/secrets.js';
import { IAuthorizationTokenResponse, isAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Queue, SequencerByKey } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { runAtBoundary } from '../common/storedSecretBoundary.js';

/** The opaque id given to each provider id that is not an extension's plain name, in the order they are first seen. */
const opaqueProviderIds = new Map<string, string>();

/**
 * A provider's identity for a log line or an error message in this process; never for the protocol or for storage, which
 * keep the id itself. An id made only of letters, digits, '.', '_' and '-' is an extension's own name for its provider and
 * is shown as it is. Any other id is shown as an opaque id, the same for the same id in this process: a dynamic provider's
 * id is its issuer string (and resource), which can hold a credential in its user info, path or query. The opaque id is
 * not derived from the id's text, so it confirms nothing about it. (The extension host has the same rule for its own
 * diagnostics, `authProviderIdForDiagnostics` in extHostAuthentication.ts; its opaque ids are its own.)
 */
export function authProviderIdForDiagnostics(id: string): string {
	if (/^[\w.-]{1,128}$/.test(id)) {
		return id;
	}
	let opaque = opaqueProviderIds.get(id);
	if (opaque === undefined) {
		opaque = `dynamic-auth-provider-${opaqueProviderIds.size + 1}`;
		opaqueProviderIds.set(id, opaque);
	}
	return opaque;
}

/**
 * The category of a failed stored read for a log line: the name of a recognised secret-storage error class (matched by
 * instanceof, written here), otherwise a fixed category. The error itself is not logged: a stored-secret error's message
 * names the secret's key, which for a dynamic provider is built from its issuer string.
 */
function storedReadFailureCategory(error: unknown): string {
	if (error instanceof InvalidStoredSecretError) {
		return 'InvalidStoredSecretError';
	}
	if (error instanceof SecretDecryptionError) {
		return 'SecretDecryptionError';
	}
	if (error instanceof SecretStorageUnavailableError) {
		return 'SecretStorageUnavailableError';
	}
	return 'unexpected error (details not logged)';
}

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
	fieldNotStringList: (index: number, field: string, valueType: string): InvalidStoredProviderListReason => ({
		reason: `entry ${index} field ${field} is not a list of strings (${valueType})`,
		localizedReason: localize({ key: 'dynamicAuthProviders.invalidList.fieldNotStringList', comment: ['{1} is a field name such as clientIds and is not translated'] }, "entry {0} field {1} is not a list of strings ({2})", index, field, valueType),
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

/**
 * Sessions were not saved because the provider has no committed registration under that client ID: it was removed (or
 * never registered) after the operation that produced them began. Its message is fixed: no provider ID (an issuer string
 * can hold a credential), no client ID, no token.
 */
export class DynamicAuthProviderNotRegisteredError extends Error {
	constructor() {
		super(localize('dynamicAuthProviders.notRegistered', "The sessions were not saved: the dynamic authentication provider is not registered with this client registration (it was removed)."));
		this.name = 'DynamicAuthProviderNotRegisteredError';
	}
}

/**
 * A client registration was not saved because the provider was removed (the explicit reset) after the registration began:
 * what the registration carries (a client ID, sessions read before the removal) is not restored. Signing in again begins a
 * new registration. Its message is fixed: no provider ID, no client ID.
 */
export class DynamicAuthProviderRemovedError extends Error {
	constructor() {
		super(localize('dynamicAuthProviders.removedDuringRegistration', "The dynamic authentication provider was not registered: it was removed while its registration was in progress. Sign in again to register it anew."));
		this.name = 'DynamicAuthProviderRemovedError';
	}
}

/**
 * A client registration was written but the provider list could not be committed, and the previous stored client
 * registration could not be restored either. Its message is fixed and names the explicit reset; it carries no cause.
 */
export class DynamicAuthRegistrationRecoveryError extends Error {
	constructor() {
		super(localize('dynamicAuthProviders.registrationRecoveryFailed', "The client registration could not be saved, and the previous stored client registration could not be restored. Remove the provider with the command 'Authentication: Remove Dynamic Authentication Providers', then sign in again."));
		this.name = 'DynamicAuthRegistrationRecoveryError';
	}
}

/** A stored entry after validation and before the issuer migration. */
type StoredProviderInfo = { providerId: string; clientId: string; label: string; authorizationServer?: string; issuer?: string };

const REQUIRED_STRING_FIELDS = ['providerId', 'clientId', 'label'] as const;
const OPTIONAL_STRING_FIELDS = ['authorizationServer', 'issuer'] as const;

/**
 * One entry of the cleanup index: a provider whose client registration or sessions may be stored, and every client ID its
 * sessions may be stored under. Identifiers and the display label only, never a client secret or a token.
 */
type CleanupIndexEntry = { providerId: string; label: string; clientIds: string[] };

const CLEANUP_INDEX_STRING_FIELDS = ['providerId', 'label'] as const;

/** The label a list entry gets (the inherited rule, review-c1 O9): the given label, else the existing entry's, else the provider ID. */
function entryLabel(providerId: string, label: string | undefined, existing: DynamicAuthenticationProviderInfo | undefined): string {
	if (label) {
		return label;
	}
	return existing ? existing.label : providerId;
}

/** `ids` without repeats, in first-seen order. */
function distinct(ids: readonly string[]): string[] {
	return [...new Set(ids)];
}

/** The JSON type of a stored value, for a diagnostic; never the value itself. */
function describeType(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	return Array.isArray(value) ? 'array' : typeof value;
}

function isOptionalString(value: unknown): boolean {
	return value === undefined || typeof value === 'string';
}

/** Total check of a stored client registration: no property is read before the value is known to be an object. */
function isStoredClientRegistration(value: unknown): value is { clientId: string; clientSecret?: string } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const registration = value as { clientId?: unknown; clientSecret?: unknown };
	return typeof registration.clientId === 'string' && registration.clientId.length > 0 && isOptionalString(registration.clientSecret);
}

/** Total check of one stored session: no property is read before the value is known to be an object. */
function isStoredSession(value: unknown): value is IAuthorizationTokenResponse & { created_at: number } {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		return false;
	}
	const session = value as Record<string, unknown>;
	return typeof session.created_at === 'number'
		&& isAuthorizationTokenResponse(session)
		&& typeof session.access_token === 'string'
		&& typeof session.token_type === 'string'
		&& (session.expires_in === undefined || typeof session.expires_in === 'number')
		&& isOptionalString(session.refresh_token)
		&& isOptionalString(session.scope)
		&& isOptionalString(session.id_token);
}

export class DynamicAuthenticationProviderStorageService extends Disposable implements IDynamicAuthenticationProviderStorageService {
	declare readonly _serviceBrand: undefined;

	private static readonly PROVIDERS_STORAGE_KEY = 'dynamicAuthProviders';

	/**
	 * The cleanup index ({@link CleanupIndexEntry}): written before a provider's client registration, and an entry is removed
	 * only by a removal that has deleted every secret it names. The provider list is the commit record of a registration; this
	 * index is what the explicit reset finds a provider by when a write or a restore after it failed, and it keeps every client
	 * ID a provider was registered under, so sessions stored under a replaced client ID are deleted too.
	 */
	private static readonly CLEANUP_INDEX_STORAGE_KEY = 'dynamicAuthProviderCleanupIndex';

	/** Per provider, the number of removals that have completed in this window ({@link getRemovalCount}). */
	private readonly _removalCounts = new Map<string, number>();

	/**
	 * Every operation that changes one provider's stored registration or sessions runs in this per-provider order, so a
	 * registration, a removal and a session write never interleave: an operation sees the previous one committed or not at all.
	 */
	private readonly _providerOperations = new SequencerByKey<string>();

	private readonly _onDidChangeTokens = this._register(new Emitter<DynamicAuthenticationProviderTokensChangeEvent>());
	readonly onDidChangeTokens: Event<DynamicAuthenticationProviderTokensChangeEvent> = this._onDidChangeTokens.event;

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@ILogService private readonly logService: ILogService
	) {
		super();

		// Listen for secret storage changes and emit events for dynamic auth provider token changes
		const queue = new Queue<boolean>();
		this._register(this.secretStorageService.onDidChangeSecret(async (key: string) => {
			let payload: { isDynamicAuthProvider: boolean; authProviderId: string; clientId: string } | undefined;
			try {
				payload = JSON.parse(key);
			} catch (error) {
				// Ignore errors... must not be a dynamic auth provider
			}
			if (payload?.isDynamicAuthProvider) {
				// A stored-read failure is logged and no event fires for it; the queue stays usable for the next change.
				void queue.queue(() => runAtBoundary(async () => {
					const tokens = await this.getSessionsForDynamicAuthProvider(payload.authProviderId, payload.clientId);
					this._onDidChangeTokens.fire({
						authProviderId: payload.authProviderId,
						clientId: payload.clientId,
						tokens
					});
				}, error => this.logService.error(`Could not read the stored sessions of ${authProviderIdForDiagnostics(payload.authProviderId)} after a change (${storedReadFailureCategory(error)}); they are kept.`)));
			}
		}));
	}

	async getClientRegistration(providerId: string): Promise<{ clientId?: string; clientSecret?: string } | undefined> {
		// First try new combined SecretStorage format
		const key = `dynamicAuthProvider:clientRegistration:${providerId}`;
		const credentialsValue = await this.secretStorageService.get(key);
		// Only undefined is absence: a stored empty string is a present value that is not a registration.
		if (credentialsValue !== undefined) {
			// The error names the key with the provider's diagnostic identity: the key holds the issuer string.
			const diagnosticKey = `dynamicAuthProvider:clientRegistration:${authProviderIdForDiagnostics(providerId)}`;
			let credentials: unknown;
			try {
				credentials = JSON.parse(credentialsValue);
			} catch {
				// The parse error quotes the stored text, so it is not carried.
				throw new InvalidStoredSecretError(diagnosticKey, 'is not valid JSON');
			}
			if (!isStoredClientRegistration(credentials)) {
				throw new InvalidStoredSecretError(diagnosticKey, 'is not a client registration with a client id and an optional client secret');
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

	getRemovalCount(providerId: string): number {
		const count = this._removalCounts.get(providerId);
		// No entry: no removal of the provider has completed in this window.
		return count === undefined ? 0 : count;
	}

	/**
	 * Staged: a registration begun before a removal of the provider completed (`removalCount` is {@link getRemovalCount} when
	 * it began) is refused before anything is read or written, so the removal stays complete. The stored list and cleanup
	 * index are validated and the previous client registration read before anything is written. Write-ahead: the cleanup
	 * index names the provider and every client ID it may have secrets under (the new one, the list entry's and the previous
	 * client registration's) before the client registration is written. The provider list, the commit record, names the new
	 * registration last. When the list cannot be committed, the previous client registration is restored before this
	 * rejects; when that restore fails too, the cleanup index still names every identity, so the explicit reset finds them.
	 */
	storeClientRegistration(providerId: string, authorizationServer: string, clientId: string, clientSecret: string | undefined, label: string | undefined, removalCount: number): Promise<void> {
		return this._providerOperations.queue(providerId, async () => {
			if (this.getRemovalCount(providerId) !== removalCount) {
				throw new DynamicAuthProviderRemovedError();
			}
			// Stage: a stored list or cleanup index that cannot be read rejects here, before any write.
			const existing = this._getStoredProviders().find(p => p.providerId === providerId);
			this._getCleanupIndex();
			const credentialsKey = this._credentialsKey(providerId);
			const previousCredentials = await this.secretStorageService.get(credentialsKey);

			// Write-ahead: a rejected index write leaves everything as it was; nothing else has been written.
			const clientIds = [clientId];
			if (existing) {
				clientIds.push(existing.clientId);
			}
			if (previousCredentials !== undefined) {
				const previousClientId = this._storedClientId(previousCredentials, 'The stored client registration being replaced is not readable; it is overwritten, and its sessions are found by the list entry and the cleanup index only.');
				if (previousClientId !== undefined) {
					clientIds.push(previousClientId);
				}
			}
			this._recordCleanupIdentity(providerId, entryLabel(providerId, label, existing), clientIds);

			// A rejected write leaves the previous registration in place: the list has not been touched.
			await this.secretStorageService.set(credentialsKey, JSON.stringify({ clientId, clientSecret }));

			// Commit: the list is read again, so a change made by another provider meanwhile is kept.
			try {
				this._trackProvider(providerId, authorizationServer, clientId, label);
			} catch (commitError) {
				await this._restoreCredentials(credentialsKey, previousCredentials);
				throw commitError;
			}
		});
	}

	/** Explicit recovery of a registration whose list commit failed: the previous client registration is written back. */
	private async _restoreCredentials(credentialsKey: string, previousCredentials: string | undefined): Promise<void> {
		try {
			if (previousCredentials === undefined) {
				await this.secretStorageService.delete(credentialsKey);
			} else {
				await this.secretStorageService.set(credentialsKey, previousCredentials);
			}
		} catch {
			// Neither the commit nor the restore succeeded: both are reported by one named error, with fixed text only.
			this.logService.error('A client registration was written but not committed, and the previous client registration could not be restored.');
			throw new DynamicAuthRegistrationRecoveryError();
		}
	}

	private _credentialsKey(providerId: string): string {
		return `dynamicAuthProvider:clientRegistration:${providerId}`;
	}

	private _sessionsKey(authProviderId: string, clientId: string): string {
		return JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
	}

	private _trackProvider(providerId: string, authorizationServer: string, clientId: string, label: string | undefined): void {
		const providers = this._getStoredProviders();

		// Check if provider already exists
		const existingProviderIndex = providers.findIndex(p => p.providerId === providerId);
		if (existingProviderIndex === -1) {
			// Add new provider with provided or default info
			const newProvider: DynamicAuthenticationProviderInfo = {
				providerId,
				label: entryLabel(providerId, label, undefined),
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
				label: entryLabel(providerId, label, existingProvider),
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

	/**
	 * Reads the cleanup index. An absent key is an empty index: a provider registered before the index existed is found by
	 * its list entry. A present value that is not a JSON array of {@link CleanupIndexEntry} is logged (key and structural
	 * reason only) and thrown as {@link InvalidStoredProviderListError}, so no caller writes over it.
	 */
	private _getCleanupIndex(): CleanupIndexEntry[] {
		const storageKey = DynamicAuthenticationProviderStorageService.CLEANUP_INDEX_STORAGE_KEY;
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
		for (let index = 0; index < parsed.length; index++) {
			const entry: unknown = parsed[index];
			if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
				throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.entryNotObject(index, describeType(entry)));
			}
			const fields = entry as Record<string, unknown>;
			for (const field of CLEANUP_INDEX_STRING_FIELDS) {
				if (typeof fields[field] !== 'string') {
					throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.fieldNotString(index, field, describeType(fields[field])));
				}
			}
			const clientIds = fields.clientIds;
			if (!Array.isArray(clientIds) || !clientIds.every(id => typeof id === 'string')) {
				throw this._invalidStoredProviders(storageKey, invalidStoredProviderListReasons.fieldNotStringList(index, 'clientIds', describeType(clientIds)));
			}
		}
		return parsed as CleanupIndexEntry[];
	}

	/**
	 * Adds `clientIds` to the provider's cleanup index entry (created if absent) and sets its label; stored only when that
	 * changes the index. The index is read again, so a change made for another provider meanwhile is kept.
	 */
	private _recordCleanupIdentity(providerId: string, label: string, clientIds: readonly string[]): void {
		const index = this._getCleanupIndex();
		const position = index.findIndex(e => e.providerId === providerId);
		if (position === -1) {
			index.push({ providerId, label, clientIds: distinct(clientIds) });
		} else {
			const entry = index[position];
			const recorded = distinct([...entry.clientIds, ...clientIds]);
			if (recorded.length === entry.clientIds.length && entry.label === label) {
				return;
			}
			index[position] = { providerId, label, clientIds: recorded };
		}
		this._storeCleanupIndex(index);
	}

	private _storeCleanupIndex(index: CleanupIndexEntry[]): void {
		this.storageService.store(
			DynamicAuthenticationProviderStorageService.CLEANUP_INDEX_STORAGE_KEY,
			JSON.stringify(index),
			StorageScope.APPLICATION,
			StorageTarget.MACHINE
		);
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

	getRemovableProviders(): ReadonlyArray<DynamicAuthenticationProviderCleanupInfo> {
		const providers = this._getStoredProviders();
		const index = this._getCleanupIndex();
		const removable: DynamicAuthenticationProviderCleanupInfo[] = providers.map(provider => {
			const entry = index.find(e => e.providerId === provider.providerId);
			const clientIds = entry ? distinct([provider.clientId, ...entry.clientIds]) : [provider.clientId];
			return { providerId: provider.providerId, label: provider.label, clientIds };
		});
		// A provider the index names and the list does not: a registration whose commit (and restore) failed.
		for (const entry of index) {
			if (!providers.some(p => p.providerId === entry.providerId)) {
				removable.push({ providerId: entry.providerId, label: entry.label, clientIds: entry.clientIds });
			}
		}
		return removable;
	}

	/**
	 * Removes the provider's sessions and client registration, then its list entry, then its cleanup index entry. The
	 * cleanup identities are removed last: a deletion that rejects leaves them in place, so a retried removal finds every
	 * stored session again. Sessions are deleted under every client ID the provider is known by: the list entry's, the
	 * cleanup index entry's and the stored client registration's. Runs in the provider's operation order, so no session
	 * write interleaves with it; once it has completed, a session write for the provider is rejected
	 * ({@link setSessionsForDynamicAuthProvider}), and so is a registration begun before it ({@link storeClientRegistration}).
	 */
	removeDynamicProvider(providerId: string): Promise<void> {
		return this._providerOperations.queue(providerId, async () => {
			// A stored list or cleanup index that cannot be read rejects here, before any deletion.
			const providerInfo = this._getStoredProviders().find(p => p.providerId === providerId);
			const indexEntry = this._getCleanupIndex().find(e => e.providerId === providerId);
			const credentialsKey = this._credentialsKey(providerId);

			const clientIds = new Set<string>();
			if (providerInfo) {
				clientIds.add(providerInfo.clientId);
			}
			if (indexEntry) {
				for (const clientId of indexEntry.clientIds) {
					clientIds.add(clientId);
				}
			}
			const storedCredentials = await this.secretStorageService.get(credentialsKey);
			if (storedCredentials !== undefined) {
				const storedClientId = this._storedClientId(storedCredentials, 'The stored client registration being removed is not readable; it is deleted with the provider, and its sessions are found by the list entry and the cleanup index only.');
				if (storedClientId !== undefined) {
					clientIds.add(storedClientId);
				}
			}

			for (const clientId of clientIds) {
				await this.secretStorageService.delete(this._sessionsKey(providerId, clientId));
			}
			await this.secretStorageService.delete(credentialsKey);

			// Commit: every stored credential of the provider is deleted; the list is read again, so a change made by
			// another provider meanwhile is kept.
			const remaining = this._getStoredProviders();
			const filteredProviders = remaining.filter(p => p.providerId !== providerId);
			if (filteredProviders.length !== remaining.length) {
				this._storeProviders(filteredProviders);
			}
			// The cleanup index entry goes last: until it is removed, the explicit reset finds the provider again.
			const index = this._getCleanupIndex();
			const filteredIndex = index.filter(e => e.providerId !== providerId);
			if (filteredIndex.length !== index.length) {
				this._storeCleanupIndex(filteredIndex);
			}
			this._removalCounts.set(providerId, this.getRemovalCount(providerId) + 1);
		});
	}

	/**
	 * The client ID of a stored registration that is being removed or replaced. An unreadable one names no client ID: it is
	 * deleted or overwritten all the same, and `unreadable` (fixed text, never the stored value) is logged.
	 */
	private _storedClientId(storedCredentials: string, unreadable: string): string | undefined {
		let parsed: unknown;
		try {
			parsed = JSON.parse(storedCredentials);
		} catch {
			// The parse error quotes the stored text, so it is not carried.
			this.logService.warn(unreadable);
			return undefined;
		}
		if (!isStoredClientRegistration(parsed)) {
			this.logService.warn(unreadable);
			return undefined;
		}
		return parsed.clientId;
	}

	async getSessionsForDynamicAuthProvider(authProviderId: string, clientId: string): Promise<(IAuthorizationTokenResponse & { created_at: number })[] | undefined> {
		const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId, clientId });
		const value = await this.secretStorageService.get(key);
		// Only undefined is absence: a stored empty string is a present value that is not a session list.
		if (value !== undefined) {
			// The error names the key with the provider's diagnostic identity: the key holds the issuer string.
			const diagnosticKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: authProviderIdForDiagnostics(authProviderId), clientId });
			let parsed: unknown;
			try {
				parsed = JSON.parse(value);
			} catch {
				// The parse error quotes the stored text, so it is not carried.
				throw new InvalidStoredSecretError(diagnosticKey, 'is not valid JSON');
			}
			if (!Array.isArray(parsed) || !parsed.every(isStoredSession)) {
				throw new InvalidStoredSecretError(diagnosticKey, 'is not a list of token responses');
			}
			return parsed;
		}
		return undefined;
	}

	/**
	 * Saves sessions only for a provider whose registration is committed under `clientId`, in the provider's operation
	 * order: a write from an operation that began before the provider was removed (a refresh, a sign-in) is rejected with
	 * {@link DynamicAuthProviderNotRegisteredError} and recreates nothing.
	 */
	setSessionsForDynamicAuthProvider(authProviderId: string, clientId: string, sessions: (IAuthorizationTokenResponse & { created_at: number })[]): Promise<void> {
		return this._providerOperations.queue(authProviderId, async () => {
			const providerInfo = this._getStoredProviders().find(p => p.providerId === authProviderId);
			if (!providerInfo || providerInfo.clientId !== clientId) {
				throw new DynamicAuthProviderNotRegisteredError();
			}
			await this.secretStorageService.set(this._sessionsKey(authProviderId, clientId), JSON.stringify(sessions));
			// The token responses are credentials: only their count is logged, with the provider's diagnostic identity.
			this.logService.trace(`Set ${sessions.length} session(s) for ${authProviderIdForDiagnostics(authProviderId)} in secret storage`);
		});
	}
}

registerSingleton(IDynamicAuthenticationProviderStorageService, DynamicAuthenticationProviderStorageService, InstantiationType.Delayed);
