/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../log/common/log.js';
import { EncryptionMainServiceWithElectron, IEncryptionApp, IEncryptionSafeStorage } from '../../electron-main/encryptionMainService.js';

// Planted values: none of them may appear in any log line (LOG-1).
const PLANTED_PLAINTEXT = 'planted-plaintext-7f3a91';
const PLANTED_CIPHERTEXT = 'planted-ciphertext-c4e2b8';
const ITEM = `'QuantlabTest Safe Storage'`;

function stringifyLogArgument(arg: unknown): string {
	if (arg instanceof Error) {
		return `${arg.constructor.name} ${arg.message} ${arg.stack}`;
	}
	return String(arg);
}

/** Records every log line (all levels) and every Keychain call into one ordered event list. */
class RecordingLogService extends NullLogService {
	readonly events: string[] = [];
	readonly lines: string[] = [];
	private record(level: string, message: string | Error, args: unknown[]): void {
		const line = [message, ...args].map(stringifyLogArgument).join(' ');
		this.lines.push(line);
		this.events.push(`${level}: ${line}`);
	}
	override trace(message: string, ...args: unknown[]): void { this.record('trace', message, args); }
	override debug(message: string, ...args: unknown[]): void { this.record('debug', message, args); }
	override info(message: string, ...args: unknown[]): void { this.record('info', message, args); }
	override warn(message: string, ...args: unknown[]): void { this.record('warn', message, args); }
	override error(message: string | Error, ...args: unknown[]): void { this.record('error', message, args); }
}

class KeychainDeniedError extends Error { }

class StubSafeStorage implements IEncryptionSafeStorage {
	failWith: Error | undefined;
	constructor(private readonly events: string[]) { }
	private enter(operation: string): void {
		this.events.push(`call: ${operation}`);
		if (this.failWith) {
			throw this.failWith;
		}
	}
	isEncryptionAvailable(): boolean {
		this.enter('isEncryptionAvailable');
		return true;
	}
	encryptString(plainText: string): Buffer {
		this.enter('encryptString');
		assert.strictEqual(plainText, PLANTED_PLAINTEXT);
		return Buffer.from(PLANTED_CIPHERTEXT);
	}
	decryptString(encrypted: Buffer): string {
		this.enter('decryptString');
		assert.strictEqual(encrypted.toString(), PLANTED_CIPHERTEXT);
		return PLANTED_PLAINTEXT;
	}
}

const stubApp: IEncryptionApp = {
	getName: () => 'QuantlabTest',
	commandLine: { getSwitchValue: () => '' }
};

/** A stored value as encrypt() produces it: the JSON of the ciphertext Buffer. */
const STORED_VALUE = JSON.stringify(Buffer.from(PLANTED_CIPHERTEXT));

suite('EncryptionMainService (F-PACK-13 keychain lines, LOG-1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	let logService: RecordingLogService;
	let safeStorage: StubSafeStorage;
	let service: EncryptionMainServiceWithElectron;

	setup(() => {
		logService = new RecordingLogService();
		safeStorage = new StubSafeStorage(logService.events);
		service = new EncryptionMainServiceWithElectron(safeStorage, stubApp, logService);
	});

	function assertNoPlantedValueLogged(...extraPlanted: string[]): void {
		const planted = [PLANTED_PLAINTEXT, PLANTED_CIPHERTEXT, STORED_VALUE, ...extraPlanted];
		for (const line of logService.lines) {
			for (const value of planted) {
				assert.ok(!line.includes(value), `a log line contains a planted value: ${line.replace(value, '<PLANTED>')}`);
			}
		}
		// The ciphertext also travels as the JSON byte array; its digits must not be logged either.
		const ciphertextBytes = JSON.stringify(Array.from(Buffer.from(PLANTED_CIPHERTEXT)));
		for (const line of logService.lines) {
			assert.ok(!line.includes(ciphertextBytes.slice(1, -1)), 'a log line contains the ciphertext bytes');
		}
	}

	test('isEncryptionAvailable is bracketed by INFO lines, in order', async () => {
		const available = await service.isEncryptionAvailable();
		assert.strictEqual(available, true);
		assert.deepStrictEqual(logService.events, [
			`info: [EncryptionMainService] keychain: isEncryptionAvailable ${ITEM} start`,
			'call: isEncryptionAvailable',
			`info: [EncryptionMainService] keychain: isEncryptionAvailable ${ITEM} available=true`,
		]);
		assertNoPlantedValueLogged();
	});

	test('encrypt is bracketed by INFO lines, in order; no value logged', async () => {
		const stored = await service.encrypt(PLANTED_PLAINTEXT);
		assert.strictEqual(stored, STORED_VALUE);
		assert.deepStrictEqual(logService.events, [
			`info: [EncryptionMainService] keychain: encryptString ${ITEM} start`,
			'call: encryptString',
			`info: [EncryptionMainService] keychain: encryptString ${ITEM} ok`,
		]);
		assertNoPlantedValueLogged();
	});

	test('decrypt is bracketed by INFO lines, in order; no value logged', async () => {
		const plaintext = await service.decrypt(STORED_VALUE);
		assert.strictEqual(plaintext, PLANTED_PLAINTEXT);
		assert.deepStrictEqual(logService.events, [
			`info: [EncryptionMainService] keychain: decryptString ${ITEM} start`,
			'call: decryptString',
			`info: [EncryptionMainService] keychain: decryptString ${ITEM} ok`,
		]);
		assertNoPlantedValueLogged();
	});

	test('decrypt of a stored value that is not JSON throws without the value, logs the class only, no Keychain call', async () => {
		const notJson = `not-json ${PLANTED_CIPHERTEXT}`;
		await assert.rejects(service.decrypt(notJson), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(!error.message.includes(PLANTED_CIPHERTEXT), 'the thrown message contains the stored value');
			assert.ok(error.message.includes('SyntaxError'));
			return true;
		});
		assert.deepStrictEqual(logService.events, ['error: [EncryptionMainService] Invalid encrypted value (SyntaxError)']);
		assertNoPlantedValueLogged(notJson);
	});

	test('decrypt of a stored value without data throws without the value; no Keychain call', async () => {
		const noData = JSON.stringify({ other: PLANTED_CIPHERTEXT });
		await assert.rejects(service.decrypt(noData), (error: unknown) => {
			assert.ok(error instanceof Error);
			assert.ok(!error.message.includes(PLANTED_CIPHERTEXT), 'the thrown message contains the stored value');
			return true;
		});
		assert.deepStrictEqual(logService.events, ['error: [EncryptionMainService] Invalid encrypted value (Error)']);
		assertNoPlantedValueLogged(noData);
	});

	test('a Keychain failure logs the error class (not its message) and rethrows', async () => {
		const denied = new KeychainDeniedError(`denied while reading ${PLANTED_CIPHERTEXT}`);
		safeStorage.failWith = denied;
		await assert.rejects(service.decrypt(STORED_VALUE), (error: unknown) => error === denied);
		assert.deepStrictEqual(logService.events, [
			`info: [EncryptionMainService] keychain: decryptString ${ITEM} start`,
			'call: decryptString',
			`info: [EncryptionMainService] keychain: decryptString ${ITEM} failed (KeychainDeniedError)`,
			'error: [EncryptionMainService] decryptString failed (KeychainDeniedError)',
		]);
		assertNoPlantedValueLogged();
	});

	test('isEncryptionAvailable failure is bracketed and rethrown', () => {
		const denied = new KeychainDeniedError('denied');
		safeStorage.failWith = denied;
		assert.throws(() => service.isEncryptionAvailable(), (error: unknown) => error === denied);
		assert.deepStrictEqual(logService.events, [
			`info: [EncryptionMainService] keychain: isEncryptionAvailable ${ITEM} start`,
			'call: isEncryptionAvailable',
			`info: [EncryptionMainService] keychain: isEncryptionAvailable ${ITEM} failed (KeychainDeniedError)`,
			'error: [EncryptionMainService] isEncryptionAvailable failed (KeychainDeniedError)',
		]);
	});
});
