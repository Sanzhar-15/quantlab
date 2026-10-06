/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { SecretDecryptionError } from '../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../platform/secrets/test/common/testSecretStorageService.js';
import { IBrowserWorkbenchEnvironmentService } from '../../../services/environment/browser/environmentService.js';
import { MainThreadSecretState } from '../../browser/mainThreadSecretState.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

// F-SECRETS-1: an extension's secrets.get() rejects, named, when the stored secret cannot be decrypted; it never reads as absent.
suite('MainThreadSecretState', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	class DecryptFailsSecretStorageService extends TestSecretStorageService {
		failing = true;
		override async get(key: string): Promise<string | undefined> {
			if (this.failing) {
				throw new SecretDecryptionError(key);
			}
			return super.get(key);
		}
	}

	test('$getPassword rejects with the decryption error, and a later read of the same extension succeeds', async () => {
		const secrets = new DecryptFailsSecretStorageService();
		const mainThread = store.add(new MainThreadSecretState(
			SingleProxyRPCProtocol({ $onDidChangePassword() { } }),
			secrets,
			new NullLogService(),
			{} as IBrowserWorkbenchEnvironmentService
		));
		await mainThread.$setPassword('publisher.ext', 'token', 'token-value');

		await assert.rejects(mainThread.$getPassword('publisher.ext', 'token'), (e: unknown) => e instanceof SecretDecryptionError && !e.message.includes('token-value'));

		secrets.failing = false;
		assert.strictEqual(await mainThread.$getPassword('publisher.ext', 'token'), 'token-value');
	});
});
