/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Default import (not named): the unit-test runner loads electron-main modules in an Electron renderer, whose
// 'electron' module has no `safeStorage`/`app` named exports; a named import would fail to link there.
import electron from 'electron';
import { isMacintosh, isWindows } from '../../../base/common/platform.js';
import { KnownStorageProvider, IEncryptionMainService, PasswordStoreCLIOption } from '../common/encryptionService.js';
import { ILogService } from '../../log/common/log.js';

/**
 * The part of Electron's `safeStorage` this service uses. `setUsePlainTextEncryption` and
 * `getSelectedStorageBackend` are optional because they are only available in some Electron builds.
 */
export interface IEncryptionSafeStorage {
	isEncryptionAvailable(): boolean;
	encryptString(plainText: string): Buffer;
	decryptString(encrypted: Buffer): string;
	setUsePlainTextEncryption?(usePlainText: boolean): void;
	getSelectedStorageBackend?(): string;
}

/** The part of Electron's `app` this service uses. */
export interface IEncryptionApp {
	getName(): string;
	readonly commandLine: { getSwitchValue(switchName: string): string };
}

/** The `safeStorage` calls that may read the macOS Keychain (and so may block on a Keychain prompt). */
export type KeychainOperation = 'isEncryptionAvailable' | 'encryptString' | 'decryptString';

/** The class of a thrown value, for log lines and messages: never its message, which may quote a secret. */
function errorClassOf(error: unknown): string {
	if (error instanceof Error) {
		return error.constructor.name;
	}
	return `non-Error ${typeof error}`;
}

/**
 * What a failed Keychain call throws (F-PACK-13 review c1 MUST-4): the operation and the class of the original error ONLY.
 * The original error is neither kept nor exposed (no message, no stack, no `cause`): a native safeStorage error message may
 * quote what failed, and every caller (the secret-storage service's loggers, the IPC channel that carries message and stack
 * to the renderer) passes this error on as it is.
 */
export class EncryptionKeychainError extends Error {
	constructor(readonly operation: KeychainOperation, readonly errorClass: string) {
		super(`[EncryptionMainService] keychain: ${operation} failed (${errorClass})`);
		this.name = 'EncryptionKeychainError';
	}
}

/**
 * What getKeyStorageProvider rejects with when `safeStorage.getSelectedStorageBackend()` throws (F-SECRETS-8, law §4): a failed
 * backend read is a failure, never reported as `unknown`. Fixed text only: no backend output and nothing of the caught value
 * (not its name, message, stack or class), so the IPC channel that carries message and stack to the renderer carries nothing of it.
 */
export class EncryptionStorageBackendError extends Error {
	constructor() {
		super('[EncryptionMainService] getSelectedStorageBackend failed');
		this.name = 'EncryptionStorageBackendError';
	}
}

/**
 * The encryption service with its Electron surface passed in.
 *
 * Test seam (F-PACK-13): production code uses {@link EncryptionMainService}, which passes Electron's own
 * `safeStorage` and `app`; the unit test constructs this class directly with stubs.
 *
 * Log rule (LOG-1): no plaintext, ciphertext or stored value appears in any log line or thrown message;
 * failures are reported by error class only.
 */
export class EncryptionMainServiceWithElectron implements IEncryptionMainService {
	_serviceBrand: undefined;

	constructor(
		private readonly safeStorage: IEncryptionSafeStorage,
		private readonly app: IEncryptionApp,
		private readonly logService: ILogService
	) {
		// if this commandLine switch is set, the user has opted in to using basic text encryption
		if (this.app.commandLine.getSwitchValue('password-store') === PasswordStoreCLIOption.basic) {
			this.logService.trace('[EncryptionMainService] setting usePlainTextEncryption to true...');
			this.safeStorage.setUsePlainTextEncryption?.(true);
			this.logService.trace('[EncryptionMainService] set usePlainTextEncryption to true');
		}
	}

	/**
	 * Runs one Keychain-touching `safeStorage` call between two INFO lines naming the operation and the
	 * Keychain item, so a Keychain prompt or wait is never a silent stall. A failure logs the error class and throws an
	 * {@link EncryptionKeychainError} (operation and class only) in place of the original error.
	 */
	private keychainCall<T>(operation: KeychainOperation, call: () => T, describeOutcome: (outcome: T) => string): T {
		const item = `'${this.app.getName()} Safe Storage'`;
		this.logService.info(`[EncryptionMainService] keychain: ${operation} ${item} start`);
		let outcome: T;
		try {
			outcome = call();
		} catch (e) {
			const errorClass = errorClassOf(e);
			this.logService.info(`[EncryptionMainService] keychain: ${operation} ${item} failed (${errorClass})`);
			this.logService.error(`[EncryptionMainService] ${operation} failed (${errorClass})`);
			throw new EncryptionKeychainError(operation, errorClass);
		}
		this.logService.info(`[EncryptionMainService] keychain: ${operation} ${item} ${describeOutcome(outcome)}`);
		return outcome;
	}

	async encrypt(value: string): Promise<string> {
		const encryptedBuffer = this.keychainCall('encryptString', () => this.safeStorage.encryptString(value), () => 'ok');
		return JSON.stringify(encryptedBuffer);
	}

	async decrypt(value: string): Promise<string> {
		let bufferToDecrypt: Buffer;
		try {
			const parsedValue: { data: string } = JSON.parse(value);
			if (!parsedValue.data) {
				throw new Error('[EncryptionMainService] Invalid encrypted value: no data');
			}
			bufferToDecrypt = Buffer.from(parsedValue.data);
		} catch (e) {
			// A JSON.parse SyntaxError message quotes the input, so neither the stored value nor
			// the caught error's message is logged or rethrown: only the error class.
			const errorClass = errorClassOf(e);
			this.logService.error(`[EncryptionMainService] Invalid encrypted value (${errorClass})`);
			throw new Error(`[EncryptionMainService] Invalid encrypted value (${errorClass})`);
		}
		return this.keychainCall('decryptString', () => this.safeStorage.decryptString(bufferToDecrypt), () => 'ok');
	}

	isEncryptionAvailable(): Promise<boolean> {
		const available = this.keychainCall('isEncryptionAvailable', () => this.safeStorage.isEncryptionAvailable(), outcome => `available=${outcome}`);
		return Promise.resolve(available);
	}

	getKeyStorageProvider(): Promise<KnownStorageProvider> {
		if (isWindows) {
			return Promise.resolve(KnownStorageProvider.dplib);
		}
		if (isMacintosh) {
			return Promise.resolve(KnownStorageProvider.keychainAccess);
		}
		if (!this.safeStorage.getSelectedStorageBackend) {
			// Not a failure: this Electron build has no backend query (optional per IEncryptionSafeStorage), so the provider is unknown.
			return Promise.resolve(KnownStorageProvider.unknown);
		}
		let result: KnownStorageProvider;
		try {
			this.logService.trace('[EncryptionMainService] Getting selected storage backend...');
			result = this.safeStorage.getSelectedStorageBackend() as KnownStorageProvider;
		} catch (e) {
			// F-SECRETS-8: a failed read rejects (never falls through to `unknown`). LOG-1 / F-SECRETS-7: a fixed category only
			// (`instanceof`, a boolean); nothing read from the caught value (no name, message, stack or class name).
			const category = e instanceof Error ? 'Error' : 'non-Error';
			this.logService.error(`[EncryptionMainService] getSelectedStorageBackend failed (${category})`);
			return Promise.reject(new EncryptionStorageBackendError());
		}
		this.logService.trace('[EncryptionMainService] Selected storage backend: ', result);
		return Promise.resolve(result);
	}

	async setUsePlainTextEncryption(): Promise<void> {
		if (isWindows) {
			throw new Error('Setting plain text encryption is not supported on Windows.');
		}

		if (isMacintosh) {
			throw new Error('Setting plain text encryption is not supported on macOS.');
		}

		if (!this.safeStorage.setUsePlainTextEncryption) {
			throw new Error('Setting plain text encryption is not supported.');
		}

		this.logService.trace('[EncryptionMainService] Setting usePlainTextEncryption to true...');
		this.safeStorage.setUsePlainTextEncryption(true);
		this.logService.trace('[EncryptionMainService] Set usePlainTextEncryption to true');
	}
}

export class EncryptionMainService extends EncryptionMainServiceWithElectron {
	constructor(
		@ILogService logService: ILogService
	) {
		super(electron.safeStorage, electron.app, logService);
	}
}
