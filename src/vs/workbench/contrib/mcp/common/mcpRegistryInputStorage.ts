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

	/** Imports the stored key text. It never quotes the text, and a failure is named and keeps the stored key. */
	private async _importStoredKey(existing: string): Promise<CryptoKey> {
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
				return this._importStoredKey(existing);
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

	/**
	 * Explicit recovery of this scope's sealed secrets: drops them and keeps the plain values. It is for the user who
	 * accepts that sealed secrets which cannot be unsealed are lost. It never touches the shared encryption key and
	 * never the other scope.
	 */
	public discardSealedSecrets(): void {
		const record = this._getRecord();
		record.secrets = undefined;
		record.unsealedSecrets = undefined;
		this._didChange = true;
	}

	/**
	 * Explicit recovery of a stored encryption key that cannot be imported (empty, not JSON, not a key): deletes that
	 * key, so that the next sealing makes a new one, and discards this scope's sealed secrets, which only that key
	 * could unseal. It is for an explicit act of the user. A usable key is never deleted: it rejects. The other
	 * scope's sealed secrets are not touched; its user discards them with discardSealedSecrets() there.
	 * Clearing inputs never deletes the shared key.
	 */
	public async resetUnusableEncryptionKey(): Promise<void> {
		// The record is read first, so that a record that cannot be read leaves the key in place.
		const record = this._getRecord();
		await McpRegistryInputStorage.secretSequencer.queue(async () => {
			const existing = await this._secretStorageService.get(MCP_ENCRYPTION_KEY_NAME);
			if (existing === undefined) {
				throw new Error(`The stored secret '${MCP_ENCRYPTION_KEY_NAME}' does not exist; there is nothing to reset.`);
			}
			// The import failure itself is the condition for the reset, not an error to report.
			const unusable = await this._importStoredKey(existing).then(() => false, () => true);
			if (!unusable) {
				throw new Error(`The stored secret '${MCP_ENCRYPTION_KEY_NAME}' is a usable key; it is kept.`);
			}
			await this._secretStorageService.delete(MCP_ENCRYPTION_KEY_NAME);
			this._forgetEncryptionKey();
			record.secrets = undefined;
			record.unsealedSecrets = undefined;
			this._didChange = true;
		});
	}

	/** Delete a single collection data from the storage. */
	public async clear(inputKey: string) {
		const secrets = await this._unsealSecrets();
		delete this._getRecord().values[inputKey];
		this._didChange = true;

		if (secrets.hasOwnProperty(inputKey)) {
			delete secrets[inputKey];
			await this._sealSecrets();
		}
	}

	/** Gets a mapping of saved input data. */
	public async getMap() {
		const secrets = await this._unsealSecrets();
		return { ...this._getRecord().values, ...secrets };
	}

	/** Updates the input data mapping. */
	public async setPlainText(values: Record<string, IResolvedValue>) {
		Object.assign(this._getRecord().values, values);
		this._didChange = true;
	}

	/** Updates the input secrets mapping. */
	public async setSecrets(values: Record<string, IResolvedValue>) {
		const unsealed = await this._unsealSecrets();
		Object.assign(unsealed, values);
		await this._sealSecrets();
	}

	private async _sealSecrets() {
		const key = await this._getEncryptionKey();
		const record = this._getRecord();
		return this._secretsSealerSequencer.queue(async () => {
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

			const enc = encodeBase64(VSBuffer.wrap(new Uint8Array(encrypted)));
			record.secrets = { iv: encodeBase64(VSBuffer.wrap(iv)), value: enc };
			this._didChange = true;
		});
	}

	private async _unsealSecrets(): Promise<Record<string, IResolvedValue>> {
		const record = this._getRecord();
		const sealed = record.secrets;
		if (!sealed) {
			return record.unsealedSecrets ??= {};
		}

		if (record.unsealedSecrets) {
			return record.unsealedSecrets;
		}

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
		record.unsealedSecrets = unsealedSecrets;
		return unsealedSecrets;
	}
}
