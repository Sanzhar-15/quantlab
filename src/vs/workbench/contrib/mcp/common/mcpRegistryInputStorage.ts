/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Sequencer } from '../../../../base/common/async.js';
import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { isEmptyObject } from '../../../../base/common/types.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { InvalidStoredSecretError, ISecretStorageService } from '../../../../platform/secrets/common/secrets.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IResolvedValue } from '../../../services/configurationResolver/common/configurationResolverExpression.js';

const MCP_ENCRYPTION_KEY_NAME = 'mcpEncryptionKey';
const MCP_ENCRYPTION_KEY_ALGORITHM = 'AES-GCM';
const MCP_ENCRYPTION_KEY_LEN = 256;
const MCP_ENCRYPTION_IV_LENGTH = 12; // 96 bits
const MCP_DATA_STORED_VERSION = 1;
const MCP_DATA_STORED_KEY = 'mcpInputs';

interface IStoredData {
	version: number;
	values: Record<string, IResolvedValue>;
	secrets?: { value: string; iv: string }; // base64, encrypted
}

interface IHydratedData extends IStoredData {
	unsealedSecrets?: Record<string, IResolvedValue>;
	/** The unseal in flight for this record: concurrent callers share it, so only one decrypted map is ever installed. */
	unsealing?: Promise<Record<string, IResolvedValue>>;
}

/**
 * An operation was overtaken: clearAll() replaced the stored record while it ran, so applying its result would write
 * into a record nobody reads, or return values the user just cleared. The operation is not applied, and rejects.
 */
export class McpInputsOvertakenError extends Error {
	override readonly name = 'McpInputsOvertakenError';
	constructor(operation: string) {
		super(`The stored MCP inputs were cleared while '${operation}' was running; the operation was not applied.`);
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResolvedValue(value: unknown): value is IResolvedValue {
	return isPlainObject(value)
		&& (value.value === undefined || typeof value.value === 'string')
		&& (value.input === undefined || isPlainObject(value.input));
}

function isResolvedValueMap(value: unknown): value is Record<string, IResolvedValue> {
	return isPlainObject(value) && Object.values(value).every(isResolvedValue);
}

function isOptionalSealedSecrets(value: unknown): value is { value: string; iv: string } | undefined {
	return value === undefined || (isPlainObject(value) && typeof value.value === 'string' && typeof value.iv === 'string');
}

export class McpRegistryInputStorage extends Disposable {
	private static secretSequencer = new Sequencer();
	private readonly _secretsSealerSequencer = new Sequencer();

	private _encryptionKey: Promise<CryptoKey> | undefined;

	/** Forgets the imported key, so that the next use reads the stored key again. */
	private _forgetEncryptionKey(): void {
		this._encryptionKey = undefined;
	}

	/**
	 * The key that seals the input secrets. A new key is made only when none is stored; a stored key that cannot be
	 * read rejects and is kept. A rejection is not remembered: the next call reads the secret store again. The imported
	 * key is not remembered past a change of the stored key (see the constructor) or a failed unseal.
	 */
	private _getEncryptionKey(): Promise<CryptoKey> {
		if (this._encryptionKey) {
			return this._encryptionKey;
		}
		const pending = McpRegistryInputStorage.secretSequencer.queue(async () => {
			const existing = await this._secretStorageService.get(MCP_ENCRYPTION_KEY_NAME);
			// Only undefined is absence: a stored empty string is a present key that is unusable, and is kept.
			if (existing !== undefined) {
				let parsed: JsonWebKey;
				try {
					parsed = JSON.parse(existing);
				} catch {
					// The parse error quotes the stored text, so it is not carried.
					throw new InvalidStoredSecretError(MCP_ENCRYPTION_KEY_NAME, 'is not valid JSON');
				}
				try {
					return await crypto.subtle.importKey('jwk', parsed, MCP_ENCRYPTION_KEY_ALGORITHM, false, ['encrypt', 'decrypt']);
				} catch (e) {
					throw new InvalidStoredSecretError(MCP_ENCRYPTION_KEY_NAME, 'is not a usable encryption key', { cause: e });
				}
			}

			const key = await crypto.subtle.generateKey(
				{ name: MCP_ENCRYPTION_KEY_ALGORITHM, length: MCP_ENCRYPTION_KEY_LEN },
				true,
				['encrypt', 'decrypt'],
			);

			const exported = await crypto.subtle.exportKey('jwk', key);
			await this._secretStorageService.set(MCP_ENCRYPTION_KEY_NAME, JSON.stringify(exported));
			return key;
		});
		this._encryptionKey = pending;
		// The caller still receives the rejection; this only forgets it.
		pending.then(undefined, () => {
			if (this._encryptionKey === pending) {
				this._encryptionKey = undefined;
			}
		});
		return pending;
	}

	private _didChange = false;

	private _hydrated: IHydratedData | undefined;

	private _invalidStored(problem: string): InvalidStoredSecretError {
		const error = new InvalidStoredSecretError(MCP_DATA_STORED_KEY, problem);
		this._logService.error(error);
		return error;
	}

	/**
	 * The stored record. Only an absent record starts empty: a stored record that is malformed or of another version
	 * rejects and is kept byte for byte, since replacing it would drop its sealed secrets at the next save. A rejection
	 * is not remembered: the next call reads the storage again.
	 */
	private _getRecord(): IHydratedData {
		if (this._hydrated) {
			return this._hydrated;
		}
		let stored: unknown;
		try {
			stored = this._storageService.getObject(MCP_DATA_STORED_KEY, this._scope);
		} catch {
			// The parse error quotes the stored text, so it is not carried.
			throw this._invalidStored('is not valid JSON');
		}
		if (stored === undefined) {
			return this._hydrated = { version: MCP_DATA_STORED_VERSION, values: {} };
		}
		if (!isPlainObject(stored) || typeof stored.version !== 'number') {
			throw this._invalidStored('is not a stored record of input values');
		}
		if (stored.version !== MCP_DATA_STORED_VERSION) {
			throw this._invalidStored(`has the unsupported version ${stored.version}`);
		}
		if (!isResolvedValueMap(stored.values)) {
			throw this._invalidStored('has input values of an unexpected shape');
		}
		if (!isOptionalSealedSecrets(stored.secrets)) {
			throw this._invalidStored('has sealed secrets of an unexpected shape');
		}
		return this._hydrated = { version: MCP_DATA_STORED_VERSION, values: stored.values, secrets: stored.secrets };
	}


	constructor(
		private readonly _scope: StorageScope,
		_target: StorageTarget,
		@IStorageService private readonly _storageService: IStorageService,
		@ISecretStorageService private readonly _secretStorageService: ISecretStorageService,
		@ILogService private readonly _logService: ILogService,
	) {
		super();

		// The key is shared by both scopes: a change of its stored value, by either scope or another window, makes the
		// imported key stale, so the next use reads it again.
		this._register(_secretStorageService.onDidChangeSecret(key => {
			if (key === MCP_ENCRYPTION_KEY_NAME) {
				this._forgetEncryptionKey();
			}
		}));

		this._register(_storageService.onWillSaveState(() => {
			if (this._didChange) {
				// _didChange is only set after the record was read, so this never hydrates.
				const record = this._getRecord();
				this._storageService.store(MCP_DATA_STORED_KEY, {
					version: MCP_DATA_STORED_VERSION,
					values: record.values,
					secrets: record.secrets,
				} satisfies IStoredData, this._scope, _target);
				this._didChange = false;
			}
		}));
	}

	/** Deletes all collection data from storage. */
	public clearAll() {
		// An explicit act of the user: it starts an empty record whether or not the stored one could be read.
		this._hydrated = { version: MCP_DATA_STORED_VERSION, values: {} };
		this._didChange = true;
	}

	/** The record this operation works on is still the current one: clearAll() did not replace it meanwhile. */
	private _assertCurrent(record: IHydratedData, operation: string): void {
		if (this._hydrated !== record) {
			const error = new McpInputsOvertakenError(operation);
			this._logService.error(error);
			throw error;
		}
	}

	/** Delete a single collection data from the storage. */
	public async clear(inputKey: string) {
		const record = this._getRecord();
		const secrets = await this._unsealSecrets(record);
		this._assertCurrent(record, 'clear');
		delete record.values[inputKey];
		this._didChange = true;

		if (secrets.hasOwnProperty(inputKey)) {
			delete secrets[inputKey];
			await this._sealSecrets(record, 'clear');
		}
	}

	/** Gets a mapping of saved input data. */
	public async getMap() {
		const record = this._getRecord();
		const secrets = await this._unsealSecrets(record);
		this._assertCurrent(record, 'getMap');
		return { ...record.values, ...secrets };
	}

	/** Updates the input data mapping. */
	public async setPlainText(values: Record<string, IResolvedValue>) {
		Object.assign(this._getRecord().values, values);
		this._didChange = true;
	}

	/** Updates the input secrets mapping. */
	public async setSecrets(values: Record<string, IResolvedValue>) {
		const record = this._getRecord();
		const unsealed = await this._unsealSecrets(record);
		this._assertCurrent(record, 'setSecrets');
		Object.assign(unsealed, values);
		await this._sealSecrets(record, 'setSecrets');
	}

	private async _sealSecrets(record: IHydratedData, operation: string) {
		const key = await this._getEncryptionKey();
		this._assertCurrent(record, operation);
		return this._secretsSealerSequencer.queue(async () => {
			// The turn in the sealer queue may come after a clearAll().
			this._assertCurrent(record, operation);
			if (!record.unsealedSecrets || isEmptyObject(record.unsealedSecrets)) {
				record.secrets = undefined;
				return;
			}

			const toSeal = JSON.stringify(record.unsealedSecrets);
			const iv = crypto.getRandomValues(new Uint8Array(MCP_ENCRYPTION_IV_LENGTH));
			const encrypted = await crypto.subtle.encrypt(
				{ name: MCP_ENCRYPTION_KEY_ALGORITHM, iv: iv.buffer },
				key,
				new TextEncoder().encode(toSeal).buffer as ArrayBuffer,
			);

			// Not written into a record that was replaced while encrypting.
			this._assertCurrent(record, operation);
			const enc = encodeBase64(VSBuffer.wrap(new Uint8Array(encrypted)));
			record.secrets = { iv: encodeBase64(VSBuffer.wrap(iv)), value: enc };
			this._didChange = true;
		});
	}

	/** The unsealed secrets of the record. Concurrent callers share one decrypt, so no caller's changes are overwritten by a later one's map. */
	private _unsealSecrets(record: IHydratedData): Promise<Record<string, IResolvedValue>> {
		if (!record.secrets) {
			return Promise.resolve(record.unsealedSecrets ??= {});
		}

		if (record.unsealedSecrets) {
			return Promise.resolve(record.unsealedSecrets);
		}

		if (record.unsealing) {
			return record.unsealing;
		}

		const pending = this._unsealRecord(record, record.secrets);
		record.unsealing = pending;
		// The callers still receive the rejection; this only forgets the settled attempt, so the next call reads again.
		const settled = () => {
			if (record.unsealing === pending) {
				record.unsealing = undefined;
			}
		};
		pending.then(settled, settled);
		return pending;
	}

	private async _unsealRecord(record: IHydratedData, sealed: { value: string; iv: string }): Promise<Record<string, IResolvedValue>> {
		// Sealed secrets that cannot be unsealed are kept: only clearAll() or clear(), the user's acts, remove them.
		const key = await this._getEncryptionKey();
		let decrypted: ArrayBuffer;
		try {
			const iv = decodeBase64(sealed.iv);
			const encrypted = decodeBase64(sealed.value);
			decrypted = await crypto.subtle.decrypt(
				{ name: MCP_ENCRYPTION_KEY_ALGORITHM, iv: iv.buffer as Uint8Array<ArrayBuffer> },
				key,
				encrypted.buffer as Uint8Array<ArrayBuffer>,
			);
		} catch (e) {
			// The imported key may be the wrong one: forget it, so that restoring the right one is read by this instance.
			this._forgetEncryptionKey();
			const error = new InvalidStoredSecretError(MCP_DATA_STORED_KEY, 'could not be unsealed with the stored key', { cause: e });
			this._logService.error(error);
			throw error;
		}

		let unsealedSecrets: unknown;
		try {
			unsealedSecrets = JSON.parse(new TextDecoder().decode(decrypted));
		} catch {
			// The parse error quotes the unsealed text, so it is not carried.
			throw this._invalidStored('unsealed to text that is not valid JSON');
		}
		if (!isResolvedValueMap(unsealedSecrets)) {
			throw this._invalidStored('unsealed to something that is not a map of input values');
		}
		// Not installed into a record that was replaced while decrypting.
		this._assertCurrent(record, 'unseal');
		record.unsealedSecrets = unsealedSecrets;
		return unsealedSecrets;
	}
}
