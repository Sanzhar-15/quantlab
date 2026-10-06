/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import {
	IQuantlabHostIdentityService,
	QUANTLAB_HOST_DATA_CANCEL_CHANNEL,
	QUANTLAB_HOST_DATA_FRAME_CHANNEL,
	QUANTLAB_HOST_DATA_REQUEST_CHANNEL,
	QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL,
	QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL,
	QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_REQUEST,
	QUANTLAB_HOST_IDENTITY_SIGN_OUT_CHANNEL,
	QUANTLAB_HOST_IDENTITY_SIGN_OUT_REQUEST,
	QUANTLAB_LEGACY_LOGIN_SECRET_KEYS,
	QuantlabHostError,
	type QuantlabDataFrame,
	type QuantlabHostAnswer,
	type QuantlabHostDataInvokeChannel,
	type QuantlabHostEnvelope,
	type QuantlabIdentity,
	parseDataFrame,
	parseHostAnswer,
	parseIdentity,
	quantlabHostEnvelope,
} from '../common/quantlabHostIdentity.js';
// SYNC-1: registers the retired qic.demo.* tombstones (side-effect import; this file is loaded by workbench.desktop.main.ts)
import '../common/quantlabRetiredSettings.js';

const LOG_PREFIX = '[quantlab-host-identity]';

/**
 * The workbench side of the QL-LOGIN host identity contract.
 *
 * - `getIdentity()` invokes the main process's identity channel. A rejected invoke (or an answer
 *   that is not one of the contract's two shapes) is logged and RE-THROWN; it is never turned into
 *   `signedIn: false`.
 * - The main process's `changed` broadcast is a tick: the service fires {@link onDidChangeIdentity}.
 *   The service registers and executes no command (rule 2): the identity reaches the extension host
 *   ONLY through `vscode.quantlabHost`, which the main-thread quantlab host side feeds from this
 *   service and gives to the built-in quantlab extension alone.
 * - At start the service deletes the login-bearing keys that older builds left in the workbench's
 *   secret storage (credentials at rest that nothing reads any more).
 * - Data (IPC-DATA): `request`, `subscribe` and `unsubscribe` invoke the data module's channels with
 *   the envelope `{ v: 1, input }`. An `ok: false` answer REJECTS with a {@link QuantlabHostError}
 *   carrying its code; a malformed answer rejects with a plain Error. Both are logged.
 * - Sign-out (IPC-DATA amendment): `signOut()` asks a workbench modal confirm and invokes the host's
 *   sign-out only on the user's yes. The host then moves the epoch and ticks `changed`; every store
 *   empties on that tick. The extension reaches this only through `vscode.quantlabHost.signOut()`.
 */
export class QuantlabHostIdentityService extends Disposable implements IQuantlabHostIdentityService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIdentity = this._register(new Emitter<void>());
	readonly onDidChangeIdentity = this._onDidChangeIdentity.event;

	private readonly _onDidReceiveFrame = this._register(new Emitter<QuantlabDataFrame>());
	readonly onDidReceiveFrame = this._onDidReceiveFrame.event;

	/** Source of request ids: unique for the life of this service (IPC-DATA `request.id`). */
	private requestCounter = 0;

	/** Handles subscribed and not yet ended (by `unsubscribe`, a refused subscribe or a `closed` frame). */
	private readonly openHandles = new Set<number>();

	/** Settles when the legacy-key purge has finished; it never rejects (every failure is logged and shown). */
	protected readonly legacyKeyPurge: Promise<void>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService,
		@IDialogService private readonly dialogService: IDialogService
	) {
		super();

		this.listenChanged(payload => this.onChanged(payload));
		this.listenFrames(payload => this.onFrame(payload));
		this.legacyKeyPurge = this.purgeLegacyLoginKeys();
	}

	async getIdentity(): Promise<QuantlabIdentity> {
		try {
			return parseIdentity(await this.invokeGet());
		} catch (error) {
			this.logService.error(`${LOG_PREFIX} getIdentity failed: ${toErrorMessage(error)}`);
			throw error;
		}
	}

	async signOut(): Promise<boolean> {
		const { confirmed } = await this.dialogService.confirm({
			message: localize('quantlabHostIdentity.signOut.confirm', "Sign out of Delta Plus in both views, the terminal and the workbench?"),
			primaryButton: localize({ key: 'quantlabHostIdentity.signOut.primary', comment: ['&& denotes a mnemonic'] }, "&&Sign Out"),
		});
		if (!confirmed) {
			this.logService.info(`${LOG_PREFIX} sign-out cancelled by the user; nothing sent to the host`);
			return false;
		}

		const what = 'sign-out';
		let raw: unknown;
		try {
			raw = await this.invokeSignOut();
		} catch (error) {
			this.logService.error(`${LOG_PREFIX} ${what} failed: ${toErrorMessage(error)}`);
			throw error;
		}
		const data = this.unwrapAnswer(raw, what);
		if (data !== null) {
			const error = new Error(`QuantLab host data: the ${what} answer carries data; the contract says null`);
			this.logService.error(`${LOG_PREFIX} ${error.message}`);
			throw error;
		}
		this.logService.info(`${LOG_PREFIX} signed out by the host`);
		return true;
	}

	/** Transport seam (overridden by the unit test): the sign-out `ipcRenderer.invoke`. */
	protected invokeSignOut(): Promise<unknown> {
		return ipcRenderer.invoke(QUANTLAB_HOST_IDENTITY_SIGN_OUT_CHANNEL, QUANTLAB_HOST_IDENTITY_SIGN_OUT_REQUEST);
	}

	/** Transport seam (overridden by the unit test): the one `ipcRenderer.invoke` of the contract. */
	protected invokeGet(): Promise<unknown> {
		return ipcRenderer.invoke(QUANTLAB_HOST_IDENTITY_GET_CHANNEL, QUANTLAB_HOST_IDENTITY_GET_REQUEST);
	}

	/**
	 * Transport seam (overridden by the unit test): the one `ipcRenderer.on` of the contract.
	 * The listener is not removed: the sandbox preload bridge hands `removeListener` a different
	 * function proxy than the one `on` received, so removal would be a no-op; the service lives for
	 * the window's lifetime and a fire on a disposed emitter does nothing.
	 */
	protected listenChanged(listener: (payload: unknown) => void): void {
		ipcRenderer.on(QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL, (_event: unknown, ...args: unknown[]) => listener(args[0]));
	}

	async request(op: string, input: unknown, epoch: number, token: CancellationToken): Promise<unknown> {
		if (token.isCancellationRequested) {
			// Nothing was sent, so the host has nothing to cancel; the caller still gets the contract's code.
			throw new QuantlabHostError('cancelled', 'the request was cancelled before it was sent', undefined);
		}

		const id = String(++this.requestCounter);
		const what = `request '${op}'`;
		// On cancel the host aborts the call and answers it `cancelled`: that answer settles this promise.
		const cancelListener = token.onCancellationRequested(() => this.sendCancel(id, what));
		let raw: unknown;
		try {
			raw = await this.invokeDataLogged(QUANTLAB_HOST_DATA_REQUEST_CHANNEL, quantlabHostEnvelope({ id, op, input, epoch }), what);
		} finally {
			cancelListener.dispose();
		}
		return this.unwrapAnswer(raw, what);
	}

	async subscribe(handle: number, topic: string, params: unknown, epoch: number): Promise<void> {
		if (this.openHandles.has(handle)) {
			throw new Error(`QuantLab host data: handle ${handle} is already subscribed`);
		}

		// Registered before the invoke: the host may send this handle's first frame before its answer.
		this.openHandles.add(handle);
		const what = `subscribe '${topic}' (handle ${handle})`;
		let data: unknown;
		try {
			data = this.unwrapAnswer(await this.invokeDataLogged(QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL, quantlabHostEnvelope({ handle, topic, params, epoch }), what), what);
		} catch (error) {
			this.openHandles.delete(handle);
			throw error;
		}
		if (data !== null) {
			this.openHandles.delete(handle);
			const error = new Error(`QuantLab host data: the ${what} answer carries data; the contract says null`);
			this.logService.error(`${LOG_PREFIX} ${error.message}`);
			throw error;
		}
	}

	unsubscribe(handle: number): void {
		if (!this.openHandles.delete(handle)) {
			throw new Error(`QuantLab host data: handle ${handle} is not subscribed`);
		}

		const what = `unsubscribe (handle ${handle})`;
		// Nobody awaits an unsubscribe: a failure or a non-null answer is logged as an error.
		void this.invokeData(QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL, quantlabHostEnvelope({ handle })).then(
			answer => this.expectNullAnswer(answer, what),
			error => this.logService.error(`${LOG_PREFIX} ${what} failed: ${toErrorMessage(error)}`)
		);
	}

	/** Transport seam (overridden by the unit test): the data module's `ipcRenderer.invoke` calls. */
	protected invokeData(channel: QuantlabHostDataInvokeChannel, envelope: QuantlabHostEnvelope<unknown>): Promise<unknown> {
		return ipcRenderer.invoke(channel, envelope);
	}

	/**
	 * Transport seam (overridden by the unit test): the `ipcRenderer.on` for subscription frames. Not
	 * removed, for the reason given at {@link listenChanged}.
	 */
	protected listenFrames(listener: (payload: unknown) => void): void {
		ipcRenderer.on(QUANTLAB_HOST_DATA_FRAME_CHANNEL, (_event: unknown, ...args: unknown[]) => listener(args[0]));
	}

	private async invokeDataLogged(channel: QuantlabHostDataInvokeChannel, envelope: QuantlabHostEnvelope<unknown>, what: string): Promise<unknown> {
		try {
			return await this.invokeData(channel, envelope);
		} catch (error) {
			this.logService.error(`${LOG_PREFIX} ${what} failed: ${toErrorMessage(error)}`);
			throw error;
		}
	}

	/** The answer's data, or a THROW: the refusal as its {@link QuantlabHostError}, a malformed answer as an Error. */
	private unwrapAnswer(raw: unknown, what: string): unknown {
		let answer: QuantlabHostAnswer;
		try {
			answer = parseHostAnswer(raw, what);
		} catch (error) {
			this.logService.error(`${LOG_PREFIX} ${what}: malformed answer: ${toErrorMessage(error)}`);
			throw error;
		}
		if (!answer.ok) {
			this.logService.info(`${LOG_PREFIX} ${what} refused by the host: ${answer.error.code}`);
			throw answer.error;
		}
		return answer.data;
	}

	private sendCancel(id: string, what: string): void {
		// Nobody awaits the cancel itself: a failure or a non-null answer is logged as an error, and the
		// request still settles with whatever the host answers it.
		void this.invokeData(QUANTLAB_HOST_DATA_CANCEL_CHANNEL, quantlabHostEnvelope({ id })).then(
			answer => this.expectNullAnswer(answer, `cancel of ${what}`),
			error => this.logService.error(`${LOG_PREFIX} cancel of ${what} failed: ${toErrorMessage(error)}`)
		);
	}

	private expectNullAnswer(answer: unknown, what: string): void {
		if (answer !== null) {
			this.logService.error(`${LOG_PREFIX} ${what} answered something other than null; the contract says null`);
		}
	}

	private onFrame(payload: unknown): void {
		let frame: QuantlabDataFrame;
		try {
			frame = parseDataFrame(payload);
		} catch (error) {
			// A frame that breaks the contract has no handle that can be trusted, so there is no subscriber
			// to give it to: logged as an error, not delivered.
			this.logService.error(`${LOG_PREFIX} malformed data frame not delivered: ${toErrorMessage(error)}`);
			return;
		}

		if (!this.openHandles.has(frame.handle)) {
			// Frames already in flight when a handle was unsubscribed (or its subscribe refused) land here.
			// There is no other right action: no subscriber exists to deliver to, and the host has already
			// been told (or never agreed) to end it. One log line, dropped.
			this.logService.info(`${LOG_PREFIX} frame for unknown handle ${frame.handle} dropped`);
			return;
		}

		if (frame.kind === 'state' && frame.state.kind === 'closed') {
			// The host ends the subscription with this frame and forgets it (IPC-DATA, rules): so does the service.
			this.openHandles.delete(frame.handle);
		}
		this._onDidReceiveFrame.fire(frame);
	}

	private onChanged(payload: unknown): void {
		if (payload !== null) {
			// The contract says the tick carries `null`. A pull is authoritative either way, so the tick still
			// fires, but a sender that breaks the contract is shown and logged, not ignored.
			const message = localize('quantlabHostIdentity.badTick', "The sign-in change notice from the host was malformed.");
			this.logService.error(`${LOG_PREFIX} the changed broadcast carried a payload; the contract says null`);
			this.notificationService.error(message);
		}

		this._onDidChangeIdentity.fire();
	}

	private async purgeLegacyLoginKeys(): Promise<void> {
		const failed: string[] = [];

		for (const key of QUANTLAB_LEGACY_LOGIN_SECRET_KEYS) {
			try {
				await this.secretStorageService.delete(key);
				this.logService.info(`${LOG_PREFIX} cleared legacy login key '${key}' from secret storage (no-op when absent)`);
			} catch (error) {
				failed.push(key);
				this.logService.error(`${LOG_PREFIX} could not delete legacy login key '${key}': ${toErrorMessage(error)}`);
			}
		}

		if (failed.length > 0) {
			this.notificationService.error(localize('quantlabHostIdentity.purgeFailed', "Quantlab could not remove old sign-in data from secret storage: {0}", failed.join(', ')));
		}
	}
}

// Eager: the legacy-key purge runs at window start, and the `changed` listener is attached from the start.
// No command is registered here (rule 2): the identity reaches the extension host only through `vscode.quantlabHost`.
registerSingleton(IQuantlabHostIdentityService, QuantlabHostIdentityService, InstantiationType.Eager);

// PLANT b (negative build host/neg-extiso-x, never merged): the direct identity command restored
CommandsRegistry.registerCommand('_quantlab.hostIdentity.get', accessor => accessor.get(IQuantlabHostIdentityService).getIdentity());
