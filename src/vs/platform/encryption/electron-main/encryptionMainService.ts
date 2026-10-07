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

	// QuantLab host (review c1 M8): the terminal host's start owns the launch's first Keychain calls (its token store and launch
	// cookie), made behind its painted Keychain waiting window. `safeStorage` is synchronous: a call from here before that
	// phase settled could block the main thread on a Keychain prompt with no window on screen. Every Keychain operation of this
	// service therefore waits until the app reports the phase settled (`terminalHostKeychainPhaseSettled`). A start that fails
	// or is cancelled never reports it: no Keychain call is made for a launch that is ending.
	private readonly terminalHostKeychainPhase: Promise<void>;
	private readonly releaseTerminalHostKeychainPhase: () => void;
	private terminalHostKeychainPhaseReported = false;

	constructor(
		private readonly safeStorage: IEncryptionSafeStorage,
		private readonly app: IEncryptionApp,
		private readonly logService: ILogService
	) {
		let release!: () => void;
		this.terminalHostKeychainPhase = new Promise<void>(resolve => { release = resolve; });
		this.releaseTerminalHostKeychainPhase = release;

		// if this commandLine switch is set, the user has opted in to using basic text encryption
		if (this.app.commandLine.getSwitchValue('password-store') === PasswordStoreCLIOption.basic) {
			this.logService.trace('[EncryptionMainService] setting usePlainTextEncryption to true...');
			this.safeStorage.setUsePlainTextEncryption?.(true);
			this.logService.trace('[EncryptionMainService] set usePlainTextEncryption to true');
		}
	}

	/**
	 * QuantLab host (review c1 M8): the app calls this once, from the terminal host's `onBeforeShow` port, i.e. after the
	 * start's Keychain phase settled and its waiting window closed. A second report throws: it would be a second start.
	 */
	terminalHostKeychainPhaseSettled(): void {
		if (this.terminalHostKeychainPhaseReported) {
			throw new Error('[EncryptionMainService] keychain: the terminal host Keychain phase was already reported settled');
		}
		this.terminalHostKeychainPhaseReported = true;
		this.logService.info('[EncryptionMainService] keychain: the terminal host Keychain phase settled; Keychain operations may run');
		this.releaseTerminalHostKeychainPhase();
	}

	/** Resolves once the terminal host's Keychain phase settled; a call that has to wait says so in the log first. */
	private async afterTerminalHostKeychainPhase(operation: KeychainOperation): Promise<void> {
		if (!this.terminalHostKeychainPhaseReported) {
			this.logService.info(`[EncryptionMainService] keychain: ${operation} waits for the terminal host Keychain phase`);
		}
		await this.terminalHostKeychainPhase;
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
		await this.afterTerminalHostKeychainPhase('encryptString');
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
		await this.afterTerminalHostKeychainPhase('decryptString');
		return this.keychainCall('decryptString', () => this.safeStorage.decryptString(bufferToDecrypt), () => 'ok');
	}

	async isEncryptionAvailable(): Promise<boolean> {
		await this.afterTerminalHostKeychainPhase('isEncryptionAvailable');
		return this.keychainCall('isEncryptionAvailable', () => this.safeStorage.isEncryptionAvailable(), outcome => `available=${outcome}`);
	}

	getKeyStorageProvider(): Promise<KnownStorageProvider> {
		if (isWindows) {
			return Promise.resolve(KnownStorageProvider.dplib);
		}
		if (isMacintosh) {
			return Promise.resolve(KnownStorageProvider.keychainAccess);
		}
		if (this.safeStorage.getSelectedStorageBackend) {
			try {
				this.logService.trace('[EncryptionMainService] Getting selected storage backend...');
				const result = this.safeStorage.getSelectedStorageBackend() as KnownStorageProvider;
				this.logService.trace('[EncryptionMainService] Selected storage backend: ', result);
				return Promise.resolve(result);
			} catch (e) {
				// LOG-1: the class only; the caught error's message or stack never reaches a log line (F-PACK-13 check 7).
				this.logService.error(`[EncryptionMainService] getSelectedStorageBackend failed (${errorClassOf(e)})`);
			}
		}
		return Promise.resolve(KnownStorageProvider.unknown);
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
