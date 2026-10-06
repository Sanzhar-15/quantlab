/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { Schemas } from '../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { ExtHostQuantlabHostShape, IMainContext, MainContext, MainThreadQuantlabHostShape, QuantlabHostAnswerDto, QuantlabIdentityDto, QuantlabSubscriptionStateDto } from './extHost.protocol.js';

/**
 * The ext-host half of the QuantLab host bridge (rule 2). Identity and authorised requests reach the extension host
 * ONLY through the API object {@link ExtHostQuantlabHost.createApi} makes per extension and gives ONLY to the built-in
 * `quantlab` extension: the extension's identity is the carrier. There is no command and no exported extension API.
 * The token never reaches the extension host: the main-thread side performs the requests.
 */

/** `publisher.name` of `extensions/quantlab/package.json`. */
const QUANTLAB_EXTENSION_ID = 'quantlab.quantlab';

const LOG_PREFIX = '[quantlab-host-bridge]';

// The object the extension sees as `vscode.quantlabHost`. `vscode.d.ts` is not edited, so the ext host cannot name the
// augmentation the extension carries (extensions/quantlab/src/quantlabHost.d.ts); these types mirror it member for member.
// (One difference, on purpose: `name` is optional here because the main side may omit it, see QuantlabIdentityDto.)

export interface QuantlabHostUser {
	readonly id: string;
	readonly email: string;
	readonly name?: string;
	readonly tier: string;
}

export interface QuantlabHostIdentity {
	readonly epoch: number;
	readonly signedIn: boolean;
	readonly user?: QuantlabHostUser;
}

export type QuantlabHostStreamState = QuantlabSubscriptionStateDto;

export interface QuantlabHostStream {
	readonly onData: Event<unknown>;
	readonly onState: Event<QuantlabHostStreamState>;
	dispose(): void;
}

export interface QuantlabHostApi {
	getIdentity(): Promise<QuantlabHostIdentity>;
	readonly onDidChangeIdentity: Event<QuantlabHostIdentity>;
	/** Sign out of every view after the user's yes in a workbench confirm: true when signed out, false when cancelled. */
	signOut(): Promise<boolean>;
	request(op: string, input: unknown, token?: CancellationToken): Promise<unknown>;
	subscribe(topic: string, params: unknown): QuantlabHostStream;
}

/** What the guard needs to know about the application. */
export interface QuantlabBuiltinFacts {
	/** The application's own built-in extensions folder (`<appRoot>/extensions`), a `file:` URI. */
	readonly builtinExtensionsLocation: URI;
}

/**
 * The trust boundary (ruling G1): true only for the extension the application shipped. ALL of: the identifier is the
 * quantlab extension's, `isBuiltin` is true, the extension is not under development, and its location is a `file:` URI
 * INSIDE the application's built-in extensions folder. `isBuiltin` alone is not enough: a user extension with the same
 * id at a higher version inherits `isBuiltin` (extensionsUtil.ts), so the location clause refuses a VSIX in the user's
 * extensions folder. `facts` is required; a built-in folder that is not a `file:` URI is a wiring error and throws.
 */
export function isQuantlabBuiltin(extension: IExtensionDescription, facts: QuantlabBuiltinFacts): boolean {
	if (!ExtensionIdentifier.equals(extension.identifier, QUANTLAB_EXTENSION_ID)) {
		return false;
	}
	if (extension.isBuiltin !== true) {
		return false;
	}
	if (extension.isUnderDevelopment !== false) {
		return false;
	}

	const root = facts.builtinExtensionsLocation;
	if (root.scheme !== Schemas.file) {
		throw new Error(`${LOG_PREFIX} the built-in extensions location must be a file: URI, got scheme '${root.scheme}'`);
	}
	const location = extension.extensionLocation;
	if (location.scheme !== Schemas.file) {
		return false;
	}
	// Normalise both first: `..` segments must not climb out of the folder.
	const normalizedRoot = extUriBiasedIgnorePathCase.normalizePath(root);
	const normalizedLocation = extUriBiasedIgnorePathCase.normalizePath(location);
	// PLANT c (negative build host/neg-extiso-x, never merged): the location clause is computed and ignored
	void (extUriBiasedIgnorePathCase.isEqualOrParent(normalizedLocation, normalizedRoot)
		&& !extUriBiasedIgnorePathCase.isEqual(normalizedLocation, normalizedRoot));

	return true;
}

function toIdentity(dto: QuantlabIdentityDto): QuantlabHostIdentity {
	if (!dto.signedIn) {
		return Object.freeze({ epoch: dto.epoch, signedIn: false });
	}
	if (dto.user === undefined) {
		throw new Error(`${LOG_PREFIX} a signed-in identity arrived without a user`);
	}
	// `tier` is copied as the main side sent it: never defaulted and never checked here (the workbench parser requires it).
	const { id, email, name, tier } = dto.user;
	const user: { id: string; email: string; name?: string; tier: string } = { id, email, tier };
	if (name !== undefined) {
		user.name = name;
	}
	return Object.freeze({ epoch: dto.epoch, signedIn: true, user: Object.freeze(user) });
}

/** A refusal from the main side as the Error the extension sees: the answer's message, `.code`, and `.status` when present. */
function toRequestError(answer: Extract<QuantlabHostAnswerDto, { readonly ok: false }>): Error & { readonly code: string; readonly status?: number } {
	const error: Error & { code: string; status?: number } = Object.assign(new Error(answer.message), { code: answer.code });
	if (answer.status !== undefined) {
		error.status = answer.status;
	}
	return error;
}

interface ISubscriptionEntry {
	readonly onData: Emitter<unknown>;
	readonly onState: Emitter<QuantlabHostStreamState>;
	/** `pending`: `$subscribe` not sent yet. `sent`: the main side may hold it, so a dispose owes one `$unsubscribe`. `ended`: nothing owed. */
	phase: 'pending' | 'sent' | 'ended';
	disposed: boolean;
}

export class ExtHostQuantlabHost implements ExtHostQuantlabHostShape {

	private readonly _proxy: MainThreadQuantlabHostShape;
	private readonly _builtinExtensionsLocation: URI | undefined;
	private readonly _onDidChangeIdentity = new Emitter<QuantlabHostIdentity>();
	private readonly _subscriptions = new Map<number, ISubscriptionEntry>();

	private _identity: QuantlabHostIdentity | undefined;
	/** Bumped by every identity the main side pushes: tells a `getIdentity` pull that a fresher identity overtook it. */
	private _identityPushes = 0;
	private _lastHandle = 0;
	private _droppedDeliveries = 0;

	/**
	 * @param appRoot the application root the extension host was given (`initData.environment.appRoot`); `undefined`
	 * when the host has none, in which case the API is refused with an Error for the quantlab extension.
	 */
	constructor(
		mainContext: IMainContext,
		private readonly _logService: ILogService,
		appRoot: URI | undefined,
	) {
		this._proxy = mainContext.getProxy(MainContext.MainThreadQuantlabHost);
		this._builtinExtensionsLocation = appRoot === undefined ? undefined : extUriBiasedIgnorePathCase.joinPath(appRoot, 'extensions');
	}

	/**
	 * The API object for `extension`, built per call, ONLY for the built-in quantlab extension; `undefined` for every
	 * other extension (including a same-id VSIX outside the built-in folder, which is logged).
	 */
	createApi(extension: IExtensionDescription): QuantlabHostApi | undefined {
		if (!ExtensionIdentifier.equals(extension.identifier, QUANTLAB_EXTENSION_ID)) {
			return undefined;
		}
		const builtinExtensionsLocation = this._builtinExtensionsLocation;
		if (builtinExtensionsLocation === undefined) {
			throw new Error(`${LOG_PREFIX} the quantlab extension asked for the host API, but the extension host has no application root to locate the built-in extensions folder`);
		}
		if (!isQuantlabBuiltin(extension, { builtinExtensionsLocation })) {
			this._logService.warn(`${LOG_PREFIX} host API refused to '${extension.identifier.value}': it is not the built-in extension (builtin, development or location clause failed)`);
			return undefined;
		}
		return Object.freeze<QuantlabHostApi>({
			getIdentity: () => this._getIdentity(),
			onDidChangeIdentity: this._onDidChangeIdentity.event,
			signOut: () => this._signOut(),
			request: (op, input, token) => this._request(op, input, token),
			subscribe: (topic, params) => this._subscribe(topic, params),
		});
	}

	/** The one property the per-extension `vscode` object gains (`undefined`: it gains none). */
	createApiProperties(extension: IExtensionDescription): { readonly quantlabHost: QuantlabHostApi } | undefined {
		const quantlabHost = this.createApi(extension);
		return quantlabHost === undefined ? undefined : { quantlabHost };
	}

	// --- main -> ext host

	$onDidChangeIdentity(dto: QuantlabIdentityDto): void {
		const identity = toIdentity(dto);
		this._identityPushes++;
		this._identity = identity;
		this._onDidChangeIdentity.fire(identity);
	}

	$onData(handle: number, data: unknown, epoch: number): void {
		const entry = this._deliverable(handle, epoch);
		if (entry === undefined) {
			return;
		}
		entry.onData.fire(data);
	}

	$onState(handle: number, state: QuantlabSubscriptionStateDto, epoch: number): void {
		const entry = this._deliverable(handle, epoch);
		if (entry === undefined) {
			return;
		}
		if (state.kind === 'closed') {
			// The main side has ended and forgotten this subscription: nothing is owed on dispose.
			entry.phase = 'ended';
			this._subscriptions.delete(handle);
		}
		entry.onState.fire(state);
	}

	// --- the API

	private _currentIdentity(): QuantlabHostIdentity {
		if (this._identity === undefined) {
			throw new Error(`${LOG_PREFIX} no identity is known although one was pushed`);
		}
		return this._identity;
	}

	private async _getIdentity(): Promise<QuantlabHostIdentity> {
		const pushesBefore = this._identityPushes;
		const identity = toIdentity(await this._proxy.$getIdentity());
		if (pushesBefore !== this._identityPushes) {
			// A pushed identity arrived while this pull was in flight: it is at least as fresh, so it wins.
			return this._currentIdentity();
		}
		this._identity = identity;
		return identity;
	}

	private async _requireEpoch(): Promise<number> {
		if (this._identity !== undefined) {
			return this._identity.epoch;
		}
		return (await this._getIdentity()).epoch;
	}

	private async _signOut(): Promise<boolean> {
		const answer = await this._proxy.$signOut();
		if (!answer.ok) {
			throw toRequestError(answer);
		}
		if (typeof answer.data !== 'boolean') {
			throw new Error(`${LOG_PREFIX} the sign-out answer carries no boolean`);
		}
		return answer.data;
	}

	private async _request(op: string, input: unknown, token: CancellationToken | undefined): Promise<unknown> {
		const epoch = await this._requireEpoch();
		// `token` is the API's documented optional parameter: no token means no cancellation.
		const answer = await this._proxy.$request(op, input, epoch, token ?? CancellationToken.None);
		if (!answer.ok) {
			throw toRequestError(answer);
		}
		return answer.data;
	}

	private _subscribe(topic: string, params: unknown): QuantlabHostStream {
		const handle = ++this._lastHandle;
		const entry: ISubscriptionEntry = {
			onData: new Emitter<unknown>(),
			onState: new Emitter<QuantlabHostStreamState>(),
			phase: 'pending',
			disposed: false,
		};
		this._subscriptions.set(handle, entry);
		void this._startSubscription(handle, entry, topic, params);
		return Object.freeze<QuantlabHostStream>({
			onData: entry.onData.event,
			onState: entry.onState.event,
			dispose: () => this._disposeSubscription(handle, entry),
		});
	}

	/** Never rejects: every failure is logged and surfaces to the extension as an `onState` of kind `error`. */
	private async _startSubscription(handle: number, entry: ISubscriptionEntry, topic: string, params: unknown): Promise<void> {
		let answer: QuantlabHostAnswerDto;
		try {
			const epoch = await this._requireEpoch();
			if (entry.disposed) {
				return;
			}
			entry.phase = 'sent';
			answer = await this._proxy.$subscribe(handle, topic, params, epoch);
		} catch (error) {
			const message = toErrorMessage(error);
			this._logService.error(`${LOG_PREFIX} subscribe '${topic}' failed without a host answer: ${message}`);
			this._failSubscription(handle, entry, message);
			return;
		}
		if (!answer.ok) {
			this._failSubscription(handle, entry, answer.message);
		}
	}

	private _failSubscription(handle: number, entry: ISubscriptionEntry, message: string): void {
		// The main side forgot a subscription it refused, so nothing is owed on dispose.
		entry.phase = 'ended';
		this._subscriptions.delete(handle);
		if (!entry.disposed) {
			entry.onState.fire({ kind: 'error', message });
		}
	}

	private _disposeSubscription(handle: number, entry: ISubscriptionEntry): void {
		if (entry.disposed) {
			return;
		}
		entry.disposed = true;
		const owesUnsubscribe = entry.phase === 'sent';
		entry.phase = 'ended';
		this._subscriptions.delete(handle);
		entry.onData.dispose();
		entry.onState.dispose();
		if (owesUnsubscribe) {
			this._proxy.$unsubscribe(handle);
		}
	}

	/** The entry a delivery is for, or `undefined` when it is dropped (unknown handle, or an epoch that is not the current one). */
	private _deliverable(handle: number, epoch: number): ISubscriptionEntry | undefined {
		const entry = this._subscriptions.get(handle);
		if (entry === undefined) {
			this._logService.debug(`${LOG_PREFIX} dropped a delivery for handle ${handle}, which is not open`);
			return undefined;
		}
		if (this._identity === undefined || epoch !== this._identity.epoch) {
			this._droppedDeliveries++;
			this._logService.debug(`${LOG_PREFIX} dropped a delivery for handle ${handle}: not the current identity epoch (${this._droppedDeliveries} dropped so far)`);
			return undefined;
		}
		return entry;
	}
}
