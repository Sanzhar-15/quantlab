/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

/**
 * QL-LOGIN host identity contract (HOST-IDENTITY-CONTRACT.md, section 3). The workbench asks the
 * host (the Electron main process) who is signed in. Only identity crosses this boundary:
 * `epoch`, `signedIn` and the user's display fields. No access token, refresh token, ticket or
 * password is ever returned, stored or logged by anything in this folder.
 *
 * LOGIN+DATA (IPC-DATA.md): authorised data calls also go through the host. The workbench sends an
 * op name, its input and the caller's identity epoch; the host adds the token and answers the data,
 * or refuses with a code. The token never leaves the main process.
 */

/** The invoke channel the main process answers with an {@link QuantlabIdentity}. */
export const QUANTLAB_HOST_IDENTITY_GET_CHANNEL = 'vscode:quantlab-host-identity:get';

/** The broadcast channel the main process uses as a TICK ("ask again"); its payload is `null` (contract amendment A-1). */
export const QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL = 'vscode:quantlab-host-identity:changed';

// REMOVED when the extension moves to vscode.quantlabHost (rule 2; OPEN in LOGIN+DATA)
/** Extension-facing command: the extension host calls it to pull the identity. */
export const QUANTLAB_EXT_GET_COMMAND = '_quantlab.hostIdentity.get';

// REMOVED when the extension moves to vscode.quantlabHost (rule 2; OPEN in LOGIN+DATA)
/** Extension-side command the service executes on every tick, when the extension has registered it. No argument: the extension pulls. */
export const QUANTLAB_EXT_DID_CHANGE_COMMAND = '_quantlab.hostIdentity.didChange';

/** The request envelope of the invoke: `{ v: 1, input: null }` (MODCH envelope; the identity op takes no input). */
export const QUANTLAB_HOST_IDENTITY_GET_REQUEST = Object.freeze({ v: 1, input: null });

/** IPC-DATA: the data module's invoke channels. Every invoke carries the envelope `{ v: 1, input }`. */
export const QUANTLAB_HOST_DATA_REQUEST_CHANNEL = 'vscode:quantlab-host-data:request';
export const QUANTLAB_HOST_DATA_CANCEL_CHANNEL = 'vscode:quantlab-host-data:cancel';
export const QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL = 'vscode:quantlab-host-data:subscribe';
export const QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL = 'vscode:quantlab-host-data:unsubscribe';

/** IPC-DATA: subscription frames, sent by main to this window's main frame only (never a broadcast). */
export const QUANTLAB_HOST_DATA_FRAME_CHANNEL = 'vscode:quantlab-host-data:frame';

export type QuantlabHostDataInvokeChannel =
	| typeof QUANTLAB_HOST_DATA_REQUEST_CHANNEL
	| typeof QUANTLAB_HOST_DATA_CANCEL_CHANNEL
	| typeof QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL
	| typeof QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL;

/** The MODCH envelope every invoke carries. */
export interface QuantlabHostEnvelope<T> {
	readonly v: 1;
	readonly input: T;
}

export function quantlabHostEnvelope<T>(input: T): QuantlabHostEnvelope<T> {
	return { v: 1, input };
}

/** IPC-DATA `Code`: every refusal the host answers with `ok: false`. */
export const QUANTLAB_HOST_ERROR_CODES = [
	'identity-changed',
	'not-signed-in',
	'no-route',
	'not-available',
	'bad-request',
	'too-large',
	'forbidden',
	'cancelled',
	'server',
] as const;

export type QuantlabHostErrorCode = typeof QUANTLAB_HOST_ERROR_CODES[number];

function isQuantlabHostErrorCode(value: unknown): value is QuantlabHostErrorCode {
	return typeof value === 'string' && (QUANTLAB_HOST_ERROR_CODES as readonly string[]).includes(value);
}

/**
 * A refusal: the host's `ok: false` answer (or `cancelled` for a request cancelled before it was
 * sent). It is only ever a REJECTION; nothing maps it to a value. Across the extension-host RPC,
 * `name`, `message` and `code` survive (`transformErrorForSerialization` in base/common/errors.ts);
 * `status` does not.
 */
export class QuantlabHostError extends Error {
	constructor(
		readonly code: QuantlabHostErrorCode,
		message: string,
		readonly status: number | undefined,
	) {
		super(message);
		this.name = 'QuantlabHostError';
	}
}

export type QuantlabSubscriptionStateKind = 'open' | 'reconnecting' | 'closed' | 'error';

const QUANTLAB_SUBSCRIPTION_STATE_KINDS: readonly QuantlabSubscriptionStateKind[] = ['open', 'reconnecting', 'closed', 'error'];

function isQuantlabSubscriptionStateKind(value: unknown): value is QuantlabSubscriptionStateKind {
	return typeof value === 'string' && (QUANTLAB_SUBSCRIPTION_STATE_KINDS as readonly string[]).includes(value);
}

export interface QuantlabSubscriptionState {
	readonly kind: QuantlabSubscriptionStateKind;
	readonly message?: string;
}

/** IPC-DATA `frame`: one message of a subscription, addressed by its handle and stamped with main's epoch. */
export type QuantlabDataFrame =
	| { readonly handle: number; readonly epoch: number; readonly kind: 'data'; readonly data: unknown }
	| { readonly handle: number; readonly epoch: number; readonly kind: 'state'; readonly state: QuantlabSubscriptionState };

/** IPC-DATA `Answer`, parsed: the data, or the refusal as the error the caller rejects with. */
export type QuantlabHostAnswer =
	| { readonly ok: true; readonly data: unknown }
	| { readonly ok: false; readonly error: QuantlabHostError };

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

/**
 * `epoch` (IPC-DATA): an integer >= 1 that main increments on every sign-in, sign-out and change of
 * user. A data call carries the epoch its caller acted on; main refuses a stale one `identity-changed`.
 */
export type QuantlabIdentity =
	| { readonly epoch: number; readonly signedIn: false }
	| { readonly epoch: number; readonly signedIn: true; readonly user: IQuantlabHostUser };

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

	/**
	 * One authorised data call (IPC-DATA `request`). Resolves with the host's `data`. A refusal REJECTS
	 * with a {@link QuantlabHostError} carrying the contract code; it is never mapped to a value.
	 * Cancelling `token` sends `cancel` for this request; the host then answers it `cancelled`.
	 */
	request(op: string, input: unknown, epoch: number, token: CancellationToken): Promise<unknown>;

	/**
	 * Open a subscription under `handle` (unique in this window; the caller chooses it). Its frames
	 * arrive on {@link onDidReceiveFrame}. A refusal rejects with a {@link QuantlabHostError}.
	 */
	subscribe(handle: number, topic: string, params: unknown, epoch: number): Promise<void>;

	/** End the subscription `handle`. Throws when `handle` is not subscribed. */
	unsubscribe(handle: number): void;

	/**
	 * Every well-formed frame for a subscribed handle. A `state` frame of kind `closed` ends the
	 * subscription: the host has forgotten it, and so has the service.
	 */
	readonly onDidReceiveFrame: Event<QuantlabDataFrame>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const IDENTITY_ERROR_PREFIX = 'QuantLab host identity';
const DATA_ERROR_PREFIX = 'QuantLab host data';

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], what: string, prefix: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.includes(key)) {
			// the message names the unexpected key, never its value
			throw new Error(`${prefix}: unexpected field '${key}' in ${what}`);
		}
	}
}

function parseEpoch(value: unknown, prefix: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
		// the message never echoes the value
		throw new Error(`${prefix}: epoch is not an integer >= 1`);
	}
	return value;
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
		assertOnlyKeys(value, ['epoch', 'signedIn'], 'a signed-out identity', IDENTITY_ERROR_PREFIX);
		return { epoch: parseEpoch(value.epoch, IDENTITY_ERROR_PREFIX), signedIn: false };
	}

	if (value.signedIn !== true) {
		throw new Error('QuantLab host identity: the answer has no boolean signedIn');
	}

	assertOnlyKeys(value, ['epoch', 'signedIn', 'user'], 'a signed-in identity', IDENTITY_ERROR_PREFIX);
	const user = value.user;
	if (!isRecord(user)) {
		throw new Error('QuantLab host identity: a signed-in answer has no user object');
	}
	assertOnlyKeys(user, ['id', 'email', 'name'], 'the user', IDENTITY_ERROR_PREFIX);
	if (typeof user.id !== 'string') {
		throw new Error('QuantLab host identity: user.id is not a string');
	}
	if (typeof user.email !== 'string') {
		throw new Error('QuantLab host identity: user.email is not a string');
	}
	if (user.name !== undefined && typeof user.name !== 'string') {
		throw new Error('QuantLab host identity: user.name is neither a string nor absent');
	}

	const epoch = parseEpoch(value.epoch, IDENTITY_ERROR_PREFIX);

	return { epoch, signedIn: true, user: { id: user.id, email: user.email, name: user.name } };
}

/**
 * Parses an IPC-DATA `Answer`. Exactly `{ ok: true, data }` or `{ ok: false, code, message, status? }`
 * (a `server` refusal must carry its `status`); anything else, extra fields included, throws.
 */
export function parseHostAnswer(value: unknown, what: string): QuantlabHostAnswer {
	if (!isRecord(value)) {
		throw new Error(`${DATA_ERROR_PREFIX}: the ${what} answer is not an object`);
	}

	if (value.ok === true) {
		assertOnlyKeys(value, ['ok', 'data'], `the ${what} answer`, DATA_ERROR_PREFIX);
		if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
			throw new Error(`${DATA_ERROR_PREFIX}: the ${what} answer has ok:true and no data`);
		}
		return { ok: true, data: value.data };
	}

	if (value.ok !== false) {
		throw new Error(`${DATA_ERROR_PREFIX}: the ${what} answer has no boolean ok`);
	}

	assertOnlyKeys(value, ['ok', 'code', 'message', 'status'], `the ${what} refusal`, DATA_ERROR_PREFIX);
	const code = value.code;
	if (!isQuantlabHostErrorCode(code)) {
		throw new Error(`${DATA_ERROR_PREFIX}: the ${what} refusal has no known code`);
	}
	const message = value.message;
	if (typeof message !== 'string') {
		throw new Error(`${DATA_ERROR_PREFIX}: the ${what} refusal has no string message`);
	}
	const rawStatus = value.status;
	let status: number | undefined;
	if (rawStatus === undefined) {
		status = undefined;
	} else if (typeof rawStatus === 'number' && Number.isInteger(rawStatus)) {
		status = rawStatus;
	} else {
		throw new Error(`${DATA_ERROR_PREFIX}: the ${what} refusal's status is neither an integer nor absent`);
	}
	if (code === 'server' && status === undefined) {
		throw new Error(`${DATA_ERROR_PREFIX}: the ${what} refusal has code 'server' and no status`);
	}

	return { ok: false, error: new QuantlabHostError(code, message, status) };
}

function parseSubscriptionState(value: unknown): QuantlabSubscriptionState {
	if (!isRecord(value)) {
		throw new Error(`${DATA_ERROR_PREFIX}: the frame's state is not an object`);
	}
	assertOnlyKeys(value, ['kind', 'message'], 'a frame state', DATA_ERROR_PREFIX);
	const kind = value.kind;
	if (!isQuantlabSubscriptionStateKind(kind)) {
		throw new Error(`${DATA_ERROR_PREFIX}: the frame's state has no known kind`);
	}
	const message = value.message;
	if (message === undefined) {
		return { kind };
	}
	if (typeof message !== 'string') {
		throw new Error(`${DATA_ERROR_PREFIX}: the frame's state message is neither a string nor absent`);
	}
	return { kind, message };
}

/** Parses an IPC-DATA `frame`: exactly the `data` or the `state` shape; anything else throws. */
export function parseDataFrame(value: unknown): QuantlabDataFrame {
	if (!isRecord(value)) {
		throw new Error(`${DATA_ERROR_PREFIX}: the frame is not an object`);
	}
	const handle = value.handle;
	if (typeof handle !== 'number' || !Number.isInteger(handle) || handle < 0) {
		throw new Error(`${DATA_ERROR_PREFIX}: the frame's handle is not an integer >= 0`);
	}

	if (value.kind === 'data') {
		assertOnlyKeys(value, ['handle', 'epoch', 'kind', 'data'], 'a data frame', DATA_ERROR_PREFIX);
		if (!Object.prototype.hasOwnProperty.call(value, 'data')) {
			throw new Error(`${DATA_ERROR_PREFIX}: a data frame has no data`);
		}
		return { handle, epoch: parseEpoch(value.epoch, DATA_ERROR_PREFIX), kind: 'data', data: value.data };
	}

	if (value.kind !== 'state') {
		throw new Error(`${DATA_ERROR_PREFIX}: the frame's kind is neither 'data' nor 'state'`);
	}
	assertOnlyKeys(value, ['handle', 'epoch', 'kind', 'state'], 'a state frame', DATA_ERROR_PREFIX);
	return { handle, epoch: parseEpoch(value.epoch, DATA_ERROR_PREFIX), kind: 'state', state: parseSubscriptionState(value.state) };
}
