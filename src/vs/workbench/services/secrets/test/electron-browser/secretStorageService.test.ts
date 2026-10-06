/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isLinux } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEncryptionService, KnownStorageProvider } from '../../../../../platform/encryption/common/encryptionService.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { SecretStorageUnavailableError } from '../../../../../platform/secrets/common/secrets.js';
import { InMemoryStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IJSONEditingService } from '../../../configuration/common/jsonEditing.js';
import { NativeSecretStorageService } from '../../electron-browser/secretStorageService.js';

class TestEncryptionService implements IEncryptionService {
	declare readonly _serviceBrand: undefined;
	available = false;
	async setUsePlainTextEncryption(): Promise<void> { this.available = true; }
	async getKeyStorageProvider(): Promise<KnownStorageProvider> { return KnownStorageProvider.basicText; }
	async encrypt(value: string): Promise<string> { return 'encrypted+' + value; }
	async decrypt(value: string): Promise<string> { return value.substring('encrypted+'.length); }
	async isEncryptionAvailable(): Promise<boolean> { return this.available; }
}

// F-SECRETS-3: with encryption unavailable a native write rejects (no in-memory fallback), and the user is still told why.
suite('NativeSecretStorageService, encryption not available', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	function createService(pressUseWeakerEncryption: boolean) {
		const encryptionService = new TestEncryptionService();
		const storageService = store.add(new InMemoryStorageService());
		const shown = { dialogs: 0, notifications: 0, argvWrites: 0 };
		const dialogService = {
			async prompt<T>(prompt: IPrompt<T>) {
				shown.dialogs++;
				if (pressUseWeakerEncryption) {
					const button = (prompt.buttons as unknown as IPromptChoice[]).find(b => b.label === 'Use weaker encryption');
					assert.ok(button, 'the Linux dialog offers "Use weaker encryption"');
					await button.run();
				}
				return {};
			}
		} as unknown as IDialogService;
		const notificationService = {
			prompt() {
				shown.notifications++;
				return undefined;
			}
		} as unknown as INotificationService;
		const jsonEditingService = { async write() { shown.argvWrites++; } } as unknown as IJSONEditingService;
		const environmentService = { useInMemorySecretStorage: false, argvResource: URI.file('/argv.json') } as unknown as INativeEnvironmentService;
		const service = store.add(new NativeSecretStorageService(
			notificationService,
			dialogService,
			{} as IOpenerService,
			jsonEditingService,
			environmentService,
			storageService,
			encryptionService,
			store.add(new NullLogService())
		));
		const secretKeys = () => storageService.keys(StorageScope.APPLICATION, StorageTarget.MACHINE).filter(key => key.startsWith('secret://'));
		return { service, shown, secretKeys, storageService };
	}

	test('set rejects named, the notification is shown once, and nothing is stored', async () => {
		const { service, shown, secretKeys } = createService(false);

		await assert.rejects(service.set('my-secret', 'my-secret-value'), (e: unknown) => e instanceof SecretStorageUnavailableError);
		await assert.rejects(service.set('my-secret', 'my-secret-value'), (e: unknown) => e instanceof SecretStorageUnavailableError);

		assert.strictEqual(shown.dialogs + shown.notifications, 1, 'the user is told once that encryption is unavailable');
		assert.strictEqual(isLinux ? shown.dialogs : shown.notifications, 1);
		assert.deepStrictEqual(secretKeys(), []);
	});

	(isLinux ? test : test.skip)('Linux: "Use weaker encryption" reinitializes and the pending write is persisted', async () => {
		const { service, shown, storageService } = createService(true);

		await service.set('my-secret', 'my-secret-value');

		assert.strictEqual(shown.dialogs, 1);
		assert.strictEqual(shown.argvWrites, 1);
		assert.strictEqual(service.type, 'persisted');
		assert.strictEqual(storageService.get('secret://my-secret', StorageScope.APPLICATION), 'encrypted+my-secret-value');
		assert.strictEqual(await service.get('my-secret'), 'my-secret-value');
	});
});
