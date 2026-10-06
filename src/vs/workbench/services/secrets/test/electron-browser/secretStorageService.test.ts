/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isLinux } from '../../../../../base/common/platform.js';
import Severity from '../../../../../base/common/severity.js';
import { URI } from '../../../../../base/common/uri.js';
import { IDialogService, IPrompt } from '../../../../../platform/dialogs/common/dialogs.js';
import { IEncryptionService, KnownStorageProvider } from '../../../../../platform/encryption/common/encryptionService.js';
import { INativeEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService, IPromptChoice } from '../../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { IJSONEditingService } from '../../../configuration/common/jsonEditing.js';
import { NativeSecretStorageService } from '../../electron-browser/secretStorageService.js';

// F-SECRETS-8 check 3: the caller of getKeyStorageProvider (the Linux "keyring not available" prompt). The test imports only exports
// the base (abb4e58ccd3) files also have, so swapping the product file back is a runtime negative control.

const MARKERS = ['planted-name-0c7e51', 'planted-message-9a24d3', 'planted-stack-61f8be'];
const READ_FAILED_TEXT = 'The OS keyring used for storing the encryption related data could not be read in your current desktop environment.';
const PLAIN_TEXT_LABEL = 'Use weaker encryption';

/** A rejection as it may arrive over IPC: markers in its name, message and stack. */
function markedRejection(): Error {
	const rejection = new Error(`backend read failed: ${MARKERS[1]}`);
	rejection.name = MARKERS[0];
	rejection.stack = `${MARKERS[0]}: ${MARKERS[1]}\n    at native (${MARKERS[2]})`;
	return rejection;
}

class RecordingLogService extends NullLogService {
	readonly lines: string[] = [];
	readonly errorLines: string[] = [];
	private record(message: string | Error, args: unknown[]): string {
		const line = [message, ...args].map(arg => arg instanceof Error ? `${arg.name} ${arg.message} ${arg.stack}` : String(arg)).join(' ');
		this.lines.push(line);
		return line;
	}
	override trace(message: string, ...args: unknown[]): void { this.record(message, args); }
	override debug(message: string, ...args: unknown[]): void { this.record(message, args); }
	override info(message: string, ...args: unknown[]): void { this.record(message, args); }
	override warn(message: string, ...args: unknown[]): void { this.record(message, args); }
	override error(message: string | Error, ...args: unknown[]): void { this.errorLines.push(this.record(message, args)); }
}

interface INotificationRecord { severity: Severity; message: string; choices: IPromptChoice[] }

(isLinux ? suite : suite.skip)('NativeSecretStorageService keyring prompt (F-SECRETS-8, Linux path)', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	let notifications: INotificationRecord[];
	let dialogs: IPrompt<unknown>[];
	let plainTextRequested: number;
	let unhandled: unknown[];
	let logService: RecordingLogService;
	const onUnhandled = (reason: unknown) => { unhandled.push(reason); };

	setup(() => {
		notifications = [];
		dialogs = [];
		plainTextRequested = 0;
		unhandled = [];
		logService = new RecordingLogService();
		process.on('unhandledRejection', onUnhandled);
	});

	teardown(() => {
		process.off('unhandledRejection', onUnhandled);
	});

	function createService(provider: () => Promise<KnownStorageProvider>): NativeSecretStorageService {
		const notificationService = { prompt: (severity: Severity, message: string, choices: IPromptChoice[]) => { notifications.push({ severity, message, choices }); } } as unknown as INotificationService;
		const dialogService = { prompt: async (prompt: IPrompt<unknown>) => { dialogs.push(prompt); return {}; } } as unknown as IDialogService;
		const openerService = { open: async () => true } as unknown as IOpenerService;
		const jsonEditingService = { write: async () => { } } as unknown as IJSONEditingService;
		const environmentService = { useInMemorySecretStorage: false, argvResource: URI.file('/argv.json') } as unknown as INativeEnvironmentService;
		const encryptionService = {
			isEncryptionAvailable: async () => false, // the keyring is not available: the prompt path
			getKeyStorageProvider: provider,
			setUsePlainTextEncryption: async () => { plainTextRequested++; },
			encrypt: async (value: string) => value,
			decrypt: async (value: string) => value,
		} as unknown as IEncryptionService;
		return store.add(new NativeSecretStorageService(notificationService, dialogService, openerService, jsonEditingService, environmentService,
			store.add(new InMemoryStorageService()), encryptionService, logService));
	}

	/** set() starts the prompt in a sequenced task; awaiting set() (queued after it on the same key) and one macrotask lets it settle. */
	async function setAndSettle(service: NativeSecretStorageService): Promise<void> {
		await service.set('k', 'v');
		await new Promise(resolve => setTimeout(resolve, 10));
	}

	test('a rejected backend read shows a visible fixed-text error, offers no plain-text choice, leaves no unhandled rejection', async () => {
		const service = createService(() => Promise.reject(markedRejection()));
		await setAndSettle(service);

		assert.deepStrictEqual(unhandled.length, 0, 'an unhandled rejection escaped the prompt');
		assert.strictEqual(notifications.length, 1, 'exactly one visible error notification');
		assert.strictEqual(notifications[0].severity, Severity.Error);
		assert.strictEqual(notifications[0].message, READ_FAILED_TEXT);
		assert.ok(!notifications[0].choices.some(choice => choice.label === PLAIN_TEXT_LABEL), 'the plain-text choice is offered on a failed read');
		assert.strictEqual(dialogs.length, 0, 'the plain-text dialog is shown on a failed read');
		assert.strictEqual(plainTextRequested, 0);
		assert.deepStrictEqual(logService.errorLines, ['[NativeSecretStorageService] the OS keyring backend could not be read']);
		for (const text of [...logService.lines, ...notifications.map(n => `${n.message} ${n.choices.map(c => c.label).join(' ')}`)]) {
			for (const marker of MARKERS) {
				assert.ok(!text.includes(marker), 'a log line or the notification carries a planted marker');
			}
		}
	});

	test('regression guard: basic_text still offers the plain-text choice in the dialog', async () => {
		const service = createService(() => Promise.resolve(KnownStorageProvider.basicText));
		await setAndSettle(service);

		assert.strictEqual(unhandled.length, 0);
		assert.strictEqual(notifications.length, 0);
		assert.strictEqual(dialogs.length, 1);
		assert.ok((dialogs[0].buttons ?? []).some(button => button.label === PLAIN_TEXT_LABEL));
		assert.deepStrictEqual(logService.errorLines, []);
	});

	test('regression guard: an unknown provider shows the generic notification, no plain-text choice', async () => {
		const service = createService(() => Promise.resolve(KnownStorageProvider.unknown));
		await setAndSettle(service);

		assert.strictEqual(unhandled.length, 0);
		assert.strictEqual(notifications.length, 1);
		assert.strictEqual(notifications[0].severity, Severity.Error);
		assert.notStrictEqual(notifications[0].message, READ_FAILED_TEXT);
		assert.ok(!notifications[0].choices.some(choice => choice.label === PLAIN_TEXT_LABEL));
		assert.strictEqual(dialogs.length, 0);
		assert.deepStrictEqual(logService.errorLines, []);
	});
});
