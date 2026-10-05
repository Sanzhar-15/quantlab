/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * QL-LOGIN host identity contract (HOST-IDENTITY-CONTRACT.md, section 3). The workbench asks the
 * host (the Electron main process) who is signed in. Only identity crosses this boundary:
 * `signedIn` and the user's display fields. No access token, refresh token, ticket or password is
 * ever returned, stored or logged by anything in this folder.
 */

/** The invoke channel the main process answers with an {@link QuantlabIdentity}. */
export const QUANTLAB_HOST_IDENTITY_GET_CHANNEL = 'vscode:quantlab-host-identity:get';

/** The broadcast channel the main process uses as a TICK ("ask again"); its payload is `null` (contract amendment A-1). */
export const QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL = 'vscode:quantlab-host-identity:changed';

/** Extension-facing command: the extension host calls it to pull the identity. */
export const QUANTLAB_EXT_GET_COMMAND = '_quantlab.hostIdentity.get';

/** Extension-side command the service executes on every tick, when the extension has registered it. No argument: the extension pulls. */
export const QUANTLAB_EXT_DID_CHANGE_COMMAND = '_quantlab.hostIdentity.didChange';

/** The request envelope of the invoke: `{ v: 1, input: null }` (MODCH envelope; the identity op takes no input). */
export const QUANTLAB_HOST_IDENTITY_GET_REQUEST = Object.freeze({ v: 1, input: null });

/**
 * Login-bearing keys that older builds wrote to the workbench's `ISecretStorageService`. They are
 * credentials at rest that no code reads any more, so the service deletes them at start (one log
 * line per deletion). Names are held by value here: the constants that used to name them are gone.
 */
export const QUANTLAB_LEGACY_LOGIN_SECRET_KEYS: readonly string[] = Object.freeze([
	'deltaplus.sessions',
	'qic.deltaplusAccessToken',
	'qic.deltaplusRefreshToken',
	'qic.deltaplusTokenExpiresAt',
	'qic.cloudAccessToken',
	'qic.cloudRefreshToken',
	'qic.cloudTokenExpiresAt',
]);

export interface IQuantlabHostUser {
	readonly id: string;
	readonly email: string;
	readonly name: string | undefined;
}

export type QuantlabIdentity =
	| { readonly signedIn: false }
	| { readonly signedIn: true; readonly user: IQuantlabHostUser };

export const IQuantlabHostIdentityService = createDecorator<IQuantlabHostIdentityService>('quantlabHostIdentityService');

export interface IQuantlabHostIdentityService {

	readonly _serviceBrand: undefined;

	/**
	 * A tick: the sign-in state may have changed. It carries no identity; call {@link getIdentity}.
	 */
	readonly onDidChangeIdentity: Event<void>;

	/**
	 * Ask the host who is signed in. A host that cannot answer REJECTS: the caller must show the
	 * error to the user. A rejection is never to be read as "signed out".
	 */
	getIdentity(): Promise<QuantlabIdentity>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			// the message names the unexpected key, never its value
			throw new Error(`QuantLab host identity: unexpected field '${key}' in ${what}`);
		}
	}
}

/**
 * The ONLY place the wire value is trusted. Accepts exactly the two members of the contract's
 * `Identity` union and throws on anything else, including extra fields (a token smuggled in as an
 * extra field is a contract violation, not something to pass along).
 */
export function parseIdentity(value: unknown): QuantlabIdentity {
	if (!isRecord(value)) {
		throw new Error('QuantLab host identity: the answer is not an object');
	}

	if (value.signedIn === false) {
		assertOnlyKeys(value, ['signedIn'], 'a signed-out identity');
		return { signedIn: false };
	}

	if (value.signedIn !== true) {
		throw new Error('QuantLab host identity: the answer has no boolean signedIn');
	}

	assertOnlyKeys(value, ['signedIn', 'user'], 'a signed-in identity');
	const user = value.user;
	if (!isRecord(user)) {
		throw new Error('QuantLab host identity: a signed-in answer has no user object');
	}
	assertOnlyKeys(user, ['id', 'email', 'name'], 'the user');
	if (typeof user.id !== 'string') {
		throw new Error('QuantLab host identity: user.id is not a string');
	}
	if (typeof user.email !== 'string') {
		throw new Error('QuantLab host identity: user.email is not a string');
	}
	if (user.name !== undefined && typeof user.name !== 'string') {
		throw new Error('QuantLab host identity: user.name is neither a string nor absent');
	}

	return { signedIn: true, user: { id: user.id, email: user.email, name: user.name } };
}
