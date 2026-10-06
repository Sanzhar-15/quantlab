/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { DynamicAuthenticationProviderStorageService, InvalidStoredProviderListError } from '../../browser/dynamicAuthenticationProviderStorageService.js';

const PROVIDERS_STORAGE_KEY = 'dynamicAuthProviders';

class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];
	readonly errors: string[] = [];
	private record(level: string, message: string | Error, args: unknown[]): string {
		const line = [level, String(message), ...args.map(arg => typeof arg === 'string' ? arg : JSON.stringify(arg))].join(' ');
		this.lines.push(line);
		return line;
	}
	override trace(message: string, ...args: unknown[]): void { this.record('trace', message, args); }
	override debug(message: string, ...args: unknown[]): void { this.record('debug', message, args); }
	override info(message: string, ...args: unknown[]): void { this.record('info', message, args); }
	override warn(message: string, ...args: unknown[]): void { this.record('warn', message, args); }
	override error(message: string | Error, ...args: unknown[]): void { this.errors.push(this.record('error', message, args)); }
	override critical(message: string | Error, ...args: unknown[]): void { this.record('critical', message, args); }
}

suite('DynamicAuthenticationProviderStorageService', () => {
	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let storageService: TestStorageService;
	let secretStorageService: TestSecretStorageService;
	let logService: RecordingLogService;
	let service: DynamicAuthenticationProviderStorageService;

	setup(() => {
		storageService = disposables.add(new TestStorageService());
		secretStorageService = disposables.add(new TestSecretStorageService());
		logService = disposables.add(new RecordingLogService());
		service = disposables.add(new DynamicAuthenticationProviderStorageService(storageService, secretStorageService, logService));
	});

	function storeRaw(raw: string): void {
		storageService.store(PROVIDERS_STORAGE_KEY, raw, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	function readRaw(): string | undefined {
		return storageService.get(PROVIDERS_STORAGE_KEY, StorageScope.APPLICATION);
	}

	function isNamedError(error: unknown): boolean {
		assert.ok(error instanceof InvalidStoredProviderListError, `expected InvalidStoredProviderListError, got ${error}`);
		assert.strictEqual(error.name, 'InvalidStoredProviderListError');
		assert.strictEqual(error.storageKey, PROVIDERS_STORAGE_KEY);
		return true;
	}

	const invalidStoredValues: { name: string; raw: string; reason: string }[] = [
		{ name: 'not JSON', raw: 'not json', reason: 'not valid JSON (SyntaxError)' },
		{ name: 'an object, not an array', raw: '{}', reason: 'not an array (object)' },
		{ name: 'an array with a null entry', raw: '[null]', reason: 'entry 0 is not an object with a string providerId' },
		{ name: 'an entry without a string providerId', raw: '[{"providerId":7,"clientSecret":"sentinel-a91f"}]', reason: 'entry 0 is not an object with a string providerId' },
	];

	for (const { name, raw, reason } of invalidStoredValues) {
		suite(`stored list is ${name}`, () => {
			setup(() => {
				storeRaw(raw);
			});

			function assertKeptAndNotLeaked(expectedErrorLines: number): void {
				assert.strictEqual(readRaw(), raw, 'the stored list must stay byte-identical');
				assert.strictEqual(logService.errors.length, expectedErrorLines, 'one error line per failed read');
				for (const line of logService.lines) {
					assert.ok(!line.includes(raw), `log line holds the stored text: ${line}`);
					assert.ok(line.includes(PROVIDERS_STORAGE_KEY), `log line names the key: ${line}`);
					assert.ok(line.includes(reason), `log line names the reason: ${line}`);
				}
			}

			test('getClientId throws the named error', () => {
				assert.throws(() => service.getClientId('p1'), (error: unknown) => {
					isNamedError(error);
					assert.strictEqual((error as InvalidStoredProviderListError).reason, reason);
					assert.ok(!(error as Error).message.includes(raw), 'error message holds the stored text');
					return true;
				});
				assertKeptAndNotLeaked(1);
			});

			test('getInteractedProviders throws the named error', () => {
				assert.throws(() => service.getInteractedProviders(), isNamedError);
				assertKeptAndNotLeaked(1);
			});

			test('getClientRegistration with no secret stored rejects with the named error', async () => {
				await assert.rejects(service.getClientRegistration('p1'), isNamedError);
				assertKeptAndNotLeaked(1);
			});

			test('storeClientRegistration rejects with the named error and writes nothing', async () => {
				await assert.rejects(service.storeClientRegistration('p1', 'https://as.example', 'client-1', 'secret-1', 'Label'), isNamedError);
				assertKeptAndNotLeaked(1);
				assert.deepStrictEqual(await secretStorageService.keys(), [], 'no secret is written after a failed read');
			});

			test('removeDynamicProvider rejects with the named error and deletes nothing', async () => {
				const credentialsKey = 'dynamicAuthProvider:clientRegistration:p1';
				await secretStorageService.set(credentialsKey, JSON.stringify({ clientId: 'client-1' }));
				await assert.rejects(service.removeDynamicProvider('p1'), isNamedError);
				assertKeptAndNotLeaked(1);
				assert.deepStrictEqual(await secretStorageService.keys(), [credentialsKey], 'no secret is deleted after a failed read');
			});
		});
	}

	suite('stored list is absent', () => {
		test('getInteractedProviders returns an empty list', () => {
			assert.strictEqual(readRaw(), undefined);
			assert.deepStrictEqual(service.getInteractedProviders(), []);
			assert.strictEqual(service.getClientId('p1'), undefined);
			assert.deepStrictEqual(logService.errors, []);
		});

		test('storeClientRegistration stores one entry', async () => {
			await service.storeClientRegistration('p1', 'https://as.example', 'client-1', 'secret-1', 'Label');
			assert.deepStrictEqual(JSON.parse(readRaw()!), [{ providerId: 'p1', label: 'Label', authorizationServer: 'https://as.example', clientId: 'client-1' }]);
			assert.deepStrictEqual(service.getInteractedProviders().map(p => p.providerId), ['p1']);
			assert.deepStrictEqual(await service.getClientRegistration('p1'), { clientId: 'client-1', clientSecret: 'secret-1' });
			assert.deepStrictEqual(logService.errors, []);
		});
	});

	suite('stored list is valid', () => {
		test('a legacy entry with issuer and no authorizationServer migrates', async () => {
			storeRaw(JSON.stringify([{ providerId: 'legacy', label: 'Legacy', issuer: 'https://issuer.example', clientId: 'client-legacy' }]));
			const providers = service.getInteractedProviders();
			assert.strictEqual(providers.length, 1);
			assert.strictEqual(providers[0].authorizationServer, 'https://issuer.example');
			assert.strictEqual(service.getClientId('legacy'), 'client-legacy');
			assert.deepStrictEqual(await service.getClientRegistration('legacy'), { clientId: 'client-legacy' });
			assert.deepStrictEqual(logService.errors, []);
		});
	});
});
