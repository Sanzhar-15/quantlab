/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ipcRenderer } from '../../../../base/parts/sandbox/electron-browser/globals.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import {
	IQuantlabHostIdentityService,
	QUANTLAB_EXT_DID_CHANGE_COMMAND,
	QUANTLAB_EXT_GET_COMMAND,
	QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_REQUEST,
	QUANTLAB_LEGACY_LOGIN_SECRET_KEYS,
	type QuantlabIdentity,
	parseIdentity,
} from '../common/quantlabHostIdentity.js';

const LOG_PREFIX = '[quantlab-host-identity]';

/**
 * The workbench side of the QL-LOGIN host identity contract.
 *
 * - `getIdentity()` invokes the main process's identity channel. A rejected invoke (or an answer
 *   that is not one of the contract's two shapes) is logged and RE-THROWN; it is never turned into
 *   `signedIn: false`.
 * - The main process's `changed` broadcast is a tick: the service fires {@link onDidChangeIdentity}
 *   and, when the extension has registered its `didChange` command, executes it (no argument; the
 *   extension pulls with the `_quantlab.hostIdentity.get` command registered below).
 * - At start the service deletes the login-bearing keys that older builds left in the workbench's
 *   secret storage (credentials at rest that nothing reads any more).
 */
export class QuantlabHostIdentityService extends Disposable implements IQuantlabHostIdentityService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeIdentity = this._register(new Emitter<void>());
	readonly onDidChangeIdentity = this._onDidChangeIdentity.event;

	/** Settles when the legacy-key purge has finished; it never rejects (every failure is logged and shown). */
	protected readonly legacyKeyPurge: Promise<void>;

	constructor(
		@ILogService private readonly logService: ILogService,
		@INotificationService private readonly notificationService: INotificationService,
		@ICommandService private readonly commandService: ICommandService,
		@ISecretStorageService private readonly secretStorageService: ISecretStorageService
	) {
		super();

		this.listenChanged(payload => this.onChanged(payload));
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

	private onChanged(payload: unknown): void {
		if (payload !== null) {
			// The contract says the tick carries `null`. A pull is authoritative either way, so the tick still
			// fires, but a sender that breaks the contract is shown and logged, not ignored.
			const message = localize('quantlabHostIdentity.badTick', "The sign-in change notice from the host was malformed.");
			this.logService.error(`${LOG_PREFIX} the changed broadcast carried a payload; the contract says null`);
			this.notificationService.error(message);
		}

		this._onDidChangeIdentity.fire();
		void this.notifyExtension();
	}

	private async notifyExtension(): Promise<void> {
		if (!CommandsRegistry.getCommand(QUANTLAB_EXT_DID_CHANGE_COMMAND)) {
			// Contract section 3: the extension is not active, so nothing is sent; it pulls with
			// `_quantlab.hostIdentity.get` at its activation.
			this.logService.trace(`${LOG_PREFIX} extension not active; it pulls at activation`);
			return;
		}

		try {
			await this.commandService.executeCommand(QUANTLAB_EXT_DID_CHANGE_COMMAND);
		} catch (error) {
			this.logService.error(`${LOG_PREFIX} the extension's didChange command failed: ${toErrorMessage(error)}`);
			this.notificationService.error(localize('quantlabHostIdentity.extensionNotifyFailed', "The Quantlab extension could not be told that the sign-in changed: {0}", toErrorMessage(error)));
		}
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

// Eager: the extension-facing `get` command below must exist before the extension host can call it.
registerSingleton(IQuantlabHostIdentityService, QuantlabHostIdentityService, InstantiationType.Eager);

// The extension host reaches the host identity only through this command (contract section 3).
CommandsRegistry.registerCommand(QUANTLAB_EXT_GET_COMMAND, accessor => accessor.get(IQuantlabHostIdentityService).getIdentity());
