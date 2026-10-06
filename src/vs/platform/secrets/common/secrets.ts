/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { SequencerByKey } from '../../../base/common/async.js';
import { IEncryptionService } from '../../encryption/common/encryptionService.js';
import { createDecorator } from '../../instantiation/common/instantiation.js';
import { IStorageService, InMemoryStorageService, StorageScope, StorageTarget } from '../../storage/common/storage.js';
import { Emitter, Event } from '../../../base/common/event.js';
import { ILogService } from '../../log/common/log.js';
import { Disposable, DisposableStore } from '../../../base/common/lifecycle.js';
import { Lazy } from '../../../base/common/lazy.js';
import { localize } from '../../../nls.js';

export const ISecretStorageService = createDecorator<ISecretStorageService>('secretStorageService');

/**
 * The only failure kind a cause can name. It is a literal, never taken from what the encryption layer threw: a name, a
 * message, a stack or a class name of a failure can all carry a secret, and a cause survives RPC serialization and logs.
 */
export type SecretFailureKind = 'encryption-service';

/** The only cause a SecretDecryptionError carries: a fixed text and a fixed kind, nothing of the failure. */
export class SecretDecryptionCause extends Error {
	override readonly name = 'SecretDecryptionCause';
	readonly kind: SecretFailureKind;
	constructor(kind: SecretFailureKind) {
		super('The encryption service failed.');
		this.kind = kind;
	}
}

/**
 * A stored secret exists but could not be decrypted (for example the OS keychain refused or is unavailable). The stored
 * value is kept: a later read can succeed, and only an explicit act of the user removes a stored secret.
 *
 * Safe by construction: the error from the encryption layer can carry the encrypted value or the text of a parse
 * error, and a cause survives RPC serialization and logs, so nothing of it is carried or passed in. The caller says
 * only that the encryption service failed; the cause is a new error with a fixed text.
 */
export class SecretDecryptionError extends Error {
	override readonly name = 'SecretDecryptionError';
	/**
	 * @param failure a literal marking that the encryption service failed; absent when there is nothing to say.
	 */
	constructor(readonly key: string, failure?: SecretFailureKind) {
		super(`The stored secret '${key}' could not be decrypted; it is kept.`, failure === undefined ? undefined : { cause: new SecretDecryptionCause(failure) });
	}
}

/** The only cause a SecretEncryptionError carries: a fixed text and a fixed kind, nothing of the failure. */
export class SecretEncryptionCause extends Error {
	override readonly name = 'SecretEncryptionCause';
	readonly kind: SecretFailureKind;
	constructor(kind: SecretFailureKind) {
		super('The encryption service failed.');
		this.kind = kind;
	}
}

/**
 * A secret could not be encrypted, so nothing was stored under its key. Safe by construction like
 * SecretDecryptionError: nothing of the error from the encryption layer is carried or passed in.
 */
export class SecretEncryptionError extends Error {
	override readonly name = 'SecretEncryptionError';
	/**
	 * @param failure a literal marking that the encryption service failed; absent when there is nothing to say.
	 */
	constructor(readonly key: string, failure?: SecretFailureKind) {
		super(`The secret '${key}' could not be encrypted; nothing was stored.`, failure === undefined ? undefined : { cause: new SecretEncryptionCause(failure) });
	}
}

/**
 * A stored secret was read but its content is not what its owner writes. It is kept: only an explicit act of the user
 * removes a stored secret. The message never quotes the content.
 */
export class InvalidStoredSecretError extends Error {
	override readonly name = 'InvalidStoredSecretError';
	constructor(readonly key: string, problem: string, options?: { cause?: unknown }) {
		super(`The stored secret '${key}' ${problem}; it is kept.`, options);
	}
}

/**
 * Secret storage is persisted but its encryption is unavailable (for example no OS keychain), so no secret can be read or
 * written. The stored secrets are kept, nothing is written anywhere else, and the failure is not remembered: the next call
 * checks again, so the stored secrets become readable once encryption is available. It carries no key and no secret.
 */
export class SecretStorageUnavailableError extends Error {
	override readonly name = 'SecretStorageUnavailableError';
	constructor() {
		super(localize('secretStorageUnavailable', "Secret storage is unavailable because encryption is not available; stored secrets are kept and can be neither read nor written until it is."));
	}
}

export interface ISecretStorageProvider {
	type: 'in-memory' | 'persisted' | 'unknown';
	get(key: string): Promise<string | undefined>;
	set(key: string, value: string): Promise<void>;
	delete(key: string): Promise<void>;
	keys?(): Promise<string[]>;
}

export interface ISecretStorageService extends ISecretStorageProvider {
	readonly _serviceBrand: undefined;
	readonly onDidChangeSecret: Event<string>;
}

export class BaseSecretStorageService extends Disposable implements ISecretStorageService {
	declare readonly _serviceBrand: undefined;

	private readonly _storagePrefix = 'secret://';

	protected readonly onDidChangeSecretEmitter = this._register(new Emitter<string>());
	readonly onDidChangeSecret: Event<string> = this.onDidChangeSecretEmitter.event;

	protected readonly _sequencer = new SequencerByKey<string>();

	private _type: 'in-memory' | 'persisted' | 'unknown' = 'unknown';

	private readonly _onDidChangeValueDisposable = this._register(new DisposableStore());

	constructor(
		private readonly _useInMemoryStorage: boolean,
		@IStorageService private _storageService: IStorageService,
		@IEncryptionService protected _encryptionService: IEncryptionService,
		@ILogService protected readonly _logService: ILogService,
	) {
		super();
	}

	/**
	 * @Note initialize must be called first so that this can be resolved properly
	 * otherwise it will return 'unknown'.
	 */
	get type() {
		return this._type;
	}

	private _lazyStorageService: Lazy<Promise<IStorageService>> = this.createLazyStorageService();
	protected get resolvedStorageService() {
		return this._lazyStorageService.value;
	}

	get(key: string): Promise<string | undefined> {
		return this._sequencer.queue(key, async () => {
			const storageService = await this.resolvedStorageService;

			const fullKey = this.getKey(key);
			this._logService.trace('[secrets] getting secret for key:', fullKey);
			const encrypted = storageService.get(fullKey, StorageScope.APPLICATION);
			// Only undefined is absence: a stored empty string is a present value that must go through decryption.
			if (encrypted === undefined) {
				this._logService.trace('[secrets] no secret found for key:', fullKey);
				return undefined;
			}

			try {
				this._logService.trace('[secrets] decrypting gotten secret for key:', fullKey);
				// If the storage service is in-memory, we don't need to decrypt
				const result = this._type === 'in-memory'
					? encrypted
					: await this._encryptionService.decrypt(encrypted);
				this._logService.trace('[secrets] decrypted secret for key:', fullKey);
				return result;
			} catch {
				// The caught value is never read: its name, message, stack and class can all carry the encrypted value.
				const error = new SecretDecryptionError(key, 'encryption-service');
				this._logService.error(error);
				throw error;
			}
		});
	}

	set(key: string, value: string): Promise<void> {
		return this._sequencer.queue(key, async () => {
			const storageService = await this.resolvedStorageService;

			this._logService.trace('[secrets] encrypting secret for key:', key);
			let encrypted;
			try {
				// If the storage service is in-memory, we don't need to encrypt
				encrypted = this._type === 'in-memory'
					? value
					: await this._encryptionService.encrypt(value);
			} catch {
				// The caught value is never read: its name, message, stack and class can all carry the secret value.
				const error = new SecretEncryptionError(key, 'encryption-service');
				this._logService.error(error);
				throw error;
			}
			const fullKey = this.getKey(key);
			this._logService.trace('[secrets] storing encrypted secret for key:', fullKey);
			storageService.store(fullKey, encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._logService.trace('[secrets] stored encrypted secret for key:', fullKey);
		});
	}

	/**
	 * The write of {@link set} without its queue, for a subclass that runs it inside its own sequenced operation on the same
	 * key (queueing again there would deadlock). An encryption failure is logged by its class only.
	 */
	protected async writeUnqueued(key: string, value: string): Promise<void> {
		const storageService = await this.resolvedStorageService;

		this._logService.trace('[secrets] encrypting secret for key:', key);
		let encrypted;
		try {
			// If the storage service is in-memory, we don't need to encrypt
			encrypted = this._type === 'in-memory'
				? value
				: await this._encryptionService.encrypt(value);
		} catch (e) {
			this._logService.error(`[secrets] encrypting the secret for key '${key}' failed: ${e instanceof Error ? e.name : typeof e}`);
			throw e;
		}
		const fullKey = this.getKey(key);
		this._logService.trace('[secrets] storing encrypted secret for key:', fullKey);
		storageService.store(fullKey, encrypted, StorageScope.APPLICATION, StorageTarget.MACHINE);
		this._logService.trace('[secrets] stored encrypted secret for key:', fullKey);
	}

	delete(key: string): Promise<void> {
		return this._sequencer.queue(key, async () => {
			const storageService = await this.resolvedStorageService;

			const fullKey = this.getKey(key);
			this._logService.trace('[secrets] deleting secret for key:', fullKey);
			storageService.remove(fullKey, StorageScope.APPLICATION);
			this._logService.trace('[secrets] deleted secret for key:', fullKey);
		});
	}

	keys(): Promise<string[]> {
		return this._sequencer.queue('__keys__', async () => {
			const storageService = await this.resolvedStorageService;
			this._logService.trace('[secrets] fetching keys of all secrets');
			const allKeys = storageService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE);
			this._logService.trace('[secrets] fetched keys of all secrets');
			return allKeys.filter(key => key.startsWith(this._storagePrefix)).map(key => key.slice(this._storagePrefix.length));
		});
	}

	/**
	 * A failed initialization is not kept: the caller receives the rejection and the next call initializes again, so a
	 * later call after encryption becomes available uses the persisted storage.
	 */
	private createLazyStorageService(): Lazy<Promise<IStorageService>> {
		const lazy: Lazy<Promise<IStorageService>> = new Lazy(() => this.initialize().catch(error => {
			if (this._lazyStorageService === lazy) {
				this._lazyStorageService = this.createLazyStorageService();
			}
			throw error;
		}));
		return lazy;
	}

	private async initialize(): Promise<IStorageService> {
		let storageService;
		if (this._useInMemoryStorage) {
			// If we already have an in-memory storage service, we don't need to recreate it
			if (this._type === 'in-memory') {
				return this._storageService;
			}
			this._logService.trace('[SecretStorageService] Using in-memory storage');
			this._type = 'in-memory';
			storageService = this._register(new InMemoryStorageService());
		} else if (await this._encryptionService.isEncryptionAvailable()) {
			this._logService.trace(`[SecretStorageService] Encryption is available, using persisted storage`);
			this._type = 'persisted';
			storageService = this._storageService;
		} else {
			// No fallback to an in-memory store: that would hide the persisted secrets and lose every secret written.
			this._type = 'unknown';
			const error = new SecretStorageUnavailableError();
			this._logService.error(`[SecretStorageService] ${error.name}: Secret storage is unavailable because encryption is not available; stored secrets are kept.`);
			throw error;
		}

		this._onDidChangeValueDisposable.clear();
		this._onDidChangeValueDisposable.add(storageService.onDidChangeValue(StorageScope.APPLICATION, undefined, this._onDidChangeValueDisposable)(e => {
			this.onDidChangeValue(e.key);
		}));
		return storageService;
	}

	protected reinitialize(): void {
		this._lazyStorageService = this.createLazyStorageService();
	}

	private onDidChangeValue(key: string): void {
		if (!key.startsWith(this._storagePrefix)) {
			return;
		}

		const secretKey = key.slice(this._storagePrefix.length);

		this._logService.trace(`[SecretStorageService] Notifying change in value for secret: ${secretKey}`);
		this.onDidChangeSecretEmitter.fire(secretKey);
	}

	private getKey(key: string): string {
		return `${this._storagePrefix}${key}`;
	}
}
