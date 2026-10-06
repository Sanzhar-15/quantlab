/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { InvalidStoredSecretError } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { getCurrentAuthenticationSessionInfo } from '../../browser/authenticationService.js';
import { DynamicAuthenticationProviderStorageService } from '../../browser/dynamicAuthenticationProviderStorageService.js';

// A stored secret that cannot be read is kept and the read rejects, naming the key and never quoting the value (F-SECRETS-1).
suite('Authentication - stored secrets that cannot be read', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function invalid(key: string, notQuoting: string) {
		return (e: unknown) => e instanceof InvalidStoredSecretError && e.key === key && !e.message.includes(notQuoting);
	}

	suite('DynamicAuthenticationProviderStorageService', () => {
		let secrets: TestSecretStorageService;

		setup(() => {
			secrets = new TestSecretStorageService();
		});

		// Seeded before construction so the secret-change listener does not read the bad values.
		function createService(): DynamicAuthenticationProviderStorageService {
			return store.add(new DynamicAuthenticationProviderStorageService(store.add(new TestStorageService()), secrets, new NullLogService()));
		}

		test('a client registration that is not JSON rejects and is kept', async () => {
			const key = 'dynamicAuthProvider:clientRegistration:p1';
			await secrets.set(key, 'secret-text {');
			const service = createService();
			await assert.rejects(service.getClientRegistration('p1'), invalid(key, 'secret-text'));
			assert.strictEqual(await secrets.get(key), 'secret-text {');
		});

		test('a client registration with neither id nor secret rejects and is kept', async () => {
			const key = 'dynamicAuthProvider:clientRegistration:p1';
			await secrets.set(key, '{"other":"secret-text"}');
			const service = createService();
			await assert.rejects(service.getClientRegistration('p1'), invalid(key, 'secret-text'));
			assert.strictEqual(await secrets.get(key), '{"other":"secret-text"}');
		});

		test('a stored session list that is not JSON rejects and is kept', async () => {
			const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId: 'c1' });
			await secrets.set(key, 'tok-secret-text [');
			const service = createService();
			await assert.rejects(service.getSessionsForDynamicAuthProvider('p1', 'c1'), invalid(key, 'tok-secret-text'));
			assert.strictEqual(await secrets.get(key), 'tok-secret-text [');
		});

		test('a stored session list of the wrong shape rejects and is kept', async () => {
			const key = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId: 'c1' });
			const stored = JSON.stringify([{ access_token: 'tok-secret-text', created_at: 'not a number' }]);
			await secrets.set(key, stored);
			const service = createService();
			await assert.rejects(service.getSessionsForDynamicAuthProvider('p1', 'c1'), invalid(key, 'tok-secret-text'));
			assert.strictEqual(await secrets.get(key), stored);
		});
	});

	suite('DynamicAuthenticationProviderStorageService logs', () => {
		test('storing sessions logs no token text at any level', async () => {
			const logged: string[] = [];
			class RecordingLogService extends NullLogService {
				override trace(message: string, ...args: unknown[]): void { logged.push(message, JSON.stringify(args)); }
				override debug(message: string, ...args: unknown[]): void { logged.push(message, JSON.stringify(args)); }
				override info(message: string, ...args: unknown[]): void { logged.push(message, JSON.stringify(args)); }
			}
			const logService: ILogService = new RecordingLogService();
			const service = store.add(new DynamicAuthenticationProviderStorageService(store.add(new TestStorageService()), new TestSecretStorageService(), logService));
			await service.setSessionsForDynamicAuthProvider('p1', 'c1', [{ access_token: 'tok-secret-text', token_type: 'Bearer', created_at: 1 }]);
			assert.ok(logged.length > 0);
			assert.ok(logged.every(line => !line.includes('tok-secret-text')), logged.join(' | '));
		});
	});

	suite('getCurrentAuthenticationSessionInfo', () => {
		const productService = { ...TestProductService, urlProtocol: 'deltaplus' };
		const key = 'deltaplus.loginAccount';

		test('no stored session reads as undefined', async () => {
			assert.strictEqual(await getCurrentAuthenticationSessionInfo(new TestSecretStorageService(), productService), undefined);
		});

		test('a stored session that is not JSON rejects and is kept, without quoting it', async () => {
			const secrets = new TestSecretStorageService();
			await secrets.set(key, 'access-token-text {');
			await assert.rejects(getCurrentAuthenticationSessionInfo(secrets, productService), invalid(key, 'access-token-text'));
			assert.strictEqual(await secrets.get(key), 'access-token-text {');
		});

		test('a stored value that is not a session rejects and is kept', async () => {
			const secrets = new TestSecretStorageService();
			await secrets.set(key, '{"accessToken":"access-token-text"}');
			await assert.rejects(getCurrentAuthenticationSessionInfo(secrets, productService), invalid(key, 'access-token-text'));
			assert.strictEqual(await secrets.get(key), '{"accessToken":"access-token-text"}');
		});
	});
});
