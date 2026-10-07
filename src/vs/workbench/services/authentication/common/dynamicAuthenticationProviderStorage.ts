/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IAuthorizationTokenResponse } from '../../../../base/common/oauth.js';
import { Event } from '../../../../base/common/event.js';

export const IDynamicAuthenticationProviderStorageService = createDecorator<IDynamicAuthenticationProviderStorageService>('dynamicAuthenticationProviderStorageService');

export interface DynamicAuthenticationProviderInfo {
	readonly providerId: string;
	readonly label: string;
	/**
	 * @deprecated in favor of authorizationServer
	 */
	readonly issuer?: string;
	readonly authorizationServer: string;
	readonly clientId: string;
}

/**
 * A dynamic authentication provider the explicit reset can find: one whose client registration or sessions may be stored,
 * whether or not its registration was committed to the provider list. Identifiers and the display label only.
 */
export interface DynamicAuthenticationProviderCleanupInfo {
	readonly providerId: string;
	readonly label: string;
	/** Every client ID the provider's sessions may be stored under. */
	readonly clientIds: readonly string[];
}

export interface DynamicAuthenticationProviderTokensChangeEvent {
	readonly authProviderId: string;
	readonly clientId: string;
	readonly tokens: (IAuthorizationTokenResponse & { created_at: number })[] | undefined;
}

/**
 * Service for managing storage of dynamic authentication provider data.
 */
export interface IDynamicAuthenticationProviderStorageService {
	readonly _serviceBrand: undefined;

	/**
	 * Event fired when tokens for a dynamic authentication provider change.
	 */
	readonly onDidChangeTokens: Event<DynamicAuthenticationProviderTokensChangeEvent>;

	/**
	 * Get the client details (ID and secret) for a dynamic authentication provider.
	 * @param providerId The provider ID or authorization server URL.
	 * @returns The client details if they exist, undefined otherwise.
	 */
	getClientRegistration(providerId: string): Promise<{ clientId?: string; clientSecret?: string } | undefined>;

	/**
	 * The number of removals of the provider ({@link removeDynamicProvider}) that have completed in this window. A
	 * registration reads it when it begins, before it reads anything stored, and passes it to {@link storeClientRegistration}.
	 * @param providerId The provider ID.
	 */
	getRemovalCount(providerId: string): number;

	/**
	 * Store both client ID and client secret for a dynamic authentication provider.
	 * @param providerId The provider ID or authorization server URL.
	 * @param authorizationServer The authorization server URL for the provider.
	 * @param clientId The client ID to store.
	 * @param clientSecret The client secret to store, if the registration has one.
	 * @param label The label for the provider, if known.
	 * @param removalCount {@link getRemovalCount} when the registration began: once a later removal of the provider has
	 * completed, the registration is refused (DynamicAuthProviderRemovedError) and nothing is stored.
	 */
	storeClientRegistration(providerId: string, authorizationServer: string, clientId: string, clientSecret: string | undefined, label: string | undefined, removalCount: number): Promise<void>;

	/**
	 * Get all dynamic authentication providers that have been interacted with.
	 * @returns Array of provider information.
	 */
	getInteractedProviders(): ReadonlyArray<DynamicAuthenticationProviderInfo>;

	/**
	 * Every dynamic authentication provider whose stored data the explicit reset can remove: those in the provider list and
	 * those whose registration was written but not committed to it.
	 */
	getRemovableProviders(): ReadonlyArray<DynamicAuthenticationProviderCleanupInfo>;

	/**
	 * Remove a dynamic authentication provider and its stored data.
	 * @param providerId The provider ID to remove.
	 * @param unregister Unregisters the provider from the window. Called once its stored data is removed, in the same
	 * synchronous step that completes the removal (advances {@link getRemovalCount}), and not at all when the removal
	 * rejects before that. A registration that reads the new count therefore begins after the unregistration was
	 * dispatched, so the unregistration never removes it.
	 */
	removeDynamicProvider(providerId: string, unregister: () => void): Promise<void>;

	/**
	 * Get sessions for a dynamic authentication provider from secret storage.
	 * @param authProviderId The authentication provider ID.
	 * @param clientId The client ID.
	 * @returns Array of authorization tokens with creation timestamps, or undefined if none exist.
	 */
	getSessionsForDynamicAuthProvider(authProviderId: string, clientId: string): Promise<(IAuthorizationTokenResponse & { created_at: number })[] | undefined>;

	/**
	 * Set sessions for a dynamic authentication provider in secret storage.
	 * @param authProviderId The authentication provider ID.
	 * @param clientId The client ID.
	 * @param sessions Array of authorization tokens with creation timestamps.
	 */
	setSessionsForDynamicAuthProvider(authProviderId: string, clientId: string, sessions: (IAuthorizationTokenResponse & { created_at: number })[]): Promise<void>;
}
