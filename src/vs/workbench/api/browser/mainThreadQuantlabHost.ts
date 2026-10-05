/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../base/common/errorMessage.js';
import { Disposable } from '../../../base/common/lifecycle.js';
import { ILogService } from '../../../platform/log/common/log.js';
import { extHostNamedCustomer, IExtHostContext } from '../../services/extensions/common/extHostCustomers.js';
import { IQuantlabHostIdentityService, QuantlabDataFrame, QuantlabHostError, QuantlabIdentity } from '../../services/quantlabHostIdentity/common/quantlabHostIdentity.js';
import { ExtHostContext, ExtHostQuantlabHostShape, MainContext, MainThreadQuantlabHostShape, QuantlabHostAnswerDto, QuantlabIdentityDto } from '../common/extHost.protocol.js';

const LOG_PREFIX = '[quantlab-host-bridge]';

/**
 * Service handles are unique across every customer in this window (one customer per extension host):
 * the host keys subscriptions by window, so two extension hosts' handles must not meet there. Each
 * customer maps its extension host's handles onto these.
 */
let lastServiceHandle = 0;

/**
 * The identity as it crosses to the extension host: field by field, so nothing the service type does
 * not name can travel with it.
 */
export function toQuantlabIdentityDto(identity: QuantlabIdentity): QuantlabIdentityDto {
	if (!identity.signedIn) {
		return { epoch: identity.epoch, signedIn: false };
	}
	const { id, email, name, tier } = identity.user;
	return { epoch: identity.epoch, signedIn: true, user: name === undefined ? { id, email, tier } : { id, email, name, tier } };
}

/** A host refusal as the protocol's answer envelope; `status` only when the host gave one. */
function toRefusalDto(error: QuantlabHostError): QuantlabHostAnswerDto {
	return error.status === undefined
		? { ok: false, code: error.code, message: error.message }
		: { ok: false, code: error.code, message: error.message, status: error.status };
}

/**
 * The main-thread half of the QuantLab host bridge (rule 2). It holds no token: identity and data come
 * from {@link IQuantlabHostIdentityService}, whose host adds the token in the main process.
 */
@extHostNamedCustomer(MainContext.MainThreadQuantlabHost)
export class MainThreadQuantlabHost extends Disposable implements MainThreadQuantlabHostShape {

	private readonly _proxy: ExtHostQuantlabHostShape;
	private readonly _serviceHandleByExtHostHandle = new Map<number, number>();
	private readonly _extHostHandleByServiceHandle = new Map<number, number>();
	private _identityPullSequence = 0;

	constructor(
		extHostContext: IExtHostContext,
		@IQuantlabHostIdentityService private readonly _hostService: IQuantlabHostIdentityService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._proxy = extHostContext.getProxy(ExtHostContext.ExtHostQuantlabHost);

		// The service's event is a tick with no identity: pull the fresh identity on each one.
		this._register(this._hostService.onDidChangeIdentity(() => void this._pushIdentity()));
		this._register(this._hostService.onDidReceiveFrame(frame => this._routeFrame(frame)));
	}

	async $getIdentity(): Promise<QuantlabIdentityDto> {
		return toQuantlabIdentityDto(await this._hostService.getIdentity());
	}

	async $signOut(): Promise<QuantlabHostAnswerDto> {
		// The service asks the user (workbench modal) before it invokes the host; a cancel resolves false.
		let signedOut: boolean;
		try {
			signedOut = await this._hostService.signOut();
		} catch (error) {
			return this._refusalOrThrow(error, 'sign-out');
		}
		return { ok: true, data: signedOut };
	}

	async $request(op: string, input: unknown, epoch: number, token: CancellationToken): Promise<QuantlabHostAnswerDto> {
		// `epoch` is the caller's, passed through untouched: the host refuses a stale one `identity-changed`.
		let data: unknown;
		try {
			data = await this._hostService.request(op, input, epoch, token);
		} catch (error) {
			return this._refusalOrThrow(error, `request '${op}'`);
		}
		return { ok: true, data };
	}

	async $subscribe(handle: number, topic: string, params: unknown, epoch: number): Promise<QuantlabHostAnswerDto> {
		if (this._serviceHandleByExtHostHandle.has(handle)) {
			throw new Error(`QuantLab host bridge: handle ${handle} is already subscribed`);
		}

		const serviceHandle = ++lastServiceHandle;
		this._serviceHandleByExtHostHandle.set(handle, serviceHandle);
		this._extHostHandleByServiceHandle.set(serviceHandle, handle);
		try {
			await this._hostService.subscribe(serviceHandle, topic, params, epoch);
		} catch (error) {
			this._forget(serviceHandle);
			return this._refusalOrThrow(error, `subscribe '${topic}' (handle ${handle})`);
		}
		return { ok: true, data: null };
	}

	$unsubscribe(handle: number): void {
		const serviceHandle = this._serviceHandleByExtHostHandle.get(handle);
		if (serviceHandle === undefined) {
			// The host already ended it (a `closed` frame crossed this call) or its subscribe was refused:
			// there is nothing left to end. One log line.
			this._logService.info(`${LOG_PREFIX} unsubscribe of handle ${handle}, which is not open; nothing sent`);
			return;
		}
		this._forget(serviceHandle);
		this._hostService.unsubscribe(serviceHandle);
	}

	override dispose(): void {
		// The extension host is going away: end every subscription it holds, so the host stops its frames.
		const open = [...this._extHostHandleByServiceHandle.keys()];
		super.dispose();
		for (const serviceHandle of open) {
			this._forget(serviceHandle);
			this._hostService.unsubscribe(serviceHandle);
		}
	}

	/**
	 * The protocol answers a host refusal as `ok: false` (an RPC rejection would drop `status`). Anything
	 * else (a malformed answer, a failed invoke) is not a host answer: logged here and REJECTED.
	 */
	private _refusalOrThrow(error: unknown, what: string): QuantlabHostAnswerDto {
		if (error instanceof QuantlabHostError) {
			return toRefusalDto(error);
		}
		this._logService.error(`${LOG_PREFIX} ${what} failed without a host answer: ${toErrorMessage(error)}`);
		throw error;
	}

	private async _pushIdentity(): Promise<void> {
		const sequence = ++this._identityPullSequence;
		let identity: QuantlabIdentityDto;
		try {
			identity = toQuantlabIdentityDto(await this._hostService.getIdentity());
		} catch (error) {
			// The service has logged the cause; this line says what it cost: the extension host keeps its
			// last identity, and the host refuses that identity's data calls once its epoch is stale.
			this._logService.error(`${LOG_PREFIX} identity change not delivered to the extension host: ${toErrorMessage(error)}`);
			return;
		}
		if (sequence !== this._identityPullSequence) {
			// A later tick's pull is in flight and is at least as fresh: this answer must not overwrite it.
			this._logService.trace(`${LOG_PREFIX} superseded identity pull not forwarded`);
			return;
		}
		this._proxy.$onDidChangeIdentity(identity);
	}

	private _routeFrame(frame: QuantlabDataFrame): void {
		const handle = this._extHostHandleByServiceHandle.get(frame.handle);
		if (handle === undefined) {
			// Another extension host's subscription: its own customer routes it. (Frames for handles that
			// nobody holds are logged by the service.)
			return;
		}

		if (frame.kind === 'data') {
			this._proxy.$onData(handle, frame.data, frame.epoch);
			return;
		}

		if (frame.state.kind === 'closed') {
			// The host has ended and forgotten this subscription, and so has the service: nothing to unsubscribe.
			this._forget(frame.handle);
		}
		this._proxy.$onState(handle, frame.state, frame.epoch);
	}

	private _forget(serviceHandle: number): void {
		const handle = this._extHostHandleByServiceHandle.get(serviceHandle);
		this._extHostHandleByServiceHandle.delete(serviceHandle);
		if (handle !== undefined) {
			this._serviceHandleByExtHostHandle.delete(handle);
		}
	}
}
