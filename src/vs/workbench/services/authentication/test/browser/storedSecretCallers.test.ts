/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Queue } from '../../../../../base/common/async.js';
import { Emitter } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService } from '../../../../../platform/quickinput/common/quickInput.js';
import { InvalidStoredSecretError, SecretDecryptionError } from '../../../../../platform/secrets/common/secrets.js';
import { TestSecretStorageService } from '../../../../../platform/secrets/test/common/testSecretStorageService.js';
import { AccountsMenuModel } from '../../../../browser/parts/accountsMenuModel.js';
import { ManageAccountsActionImpl } from '../../../../contrib/authentication/browser/actions/manageAccountsAction.js';
import { TestProductService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { DynamicAuthenticationProviderStorageService } from '../../browser/dynamicAuthenticationProviderStorageService.js';
import { IAuthenticationService } from '../../common/authentication.js';
import { runAtBoundary } from '../../common/storedSecretBoundary.js';
import { AuthenticationSessionInfo } from '../../browser/authenticationService.js';

// F-SECRETS-1 review c1 (MUST-3, MUST-4): the callers of a stored read that rejects observe the failure, show it, keep
// the stored value, and stay usable for the next valid event or read.

const marker = 'secret-marker-text';
const productService = { ...TestProductService, urlProtocol: 'deltaplus' };
const loginKey = 'deltaplus.loginAccount';

function describeLogArgument(argument: unknown): string {
	if (argument instanceof Error) {
		return `${argument.name}: ${argument.message} cause=${describeLogArgument(argument.cause)}`;
	}
	return typeof argument === 'string' ? argument : String(JSON.stringify(argument));
}

/** Records every log call at every level, trace to critical, with errors described by name, message and cause. */
class RecordingLogService extends NullLogService {
	readonly logged: string[] = [];
	private _record(message: string | Error, args: unknown[]): void {
		this.logged.push(describeLogArgument(message), ...args.map(describeLogArgument));
	}
	override trace(message: string, ...args: unknown[]): void { this._record(message, args); }
	override debug(message: string, ...args: unknown[]): void { this._record(message, args); }
	override info(message: string, ...args: unknown[]): void { this._record(message, args); }
	override warn(message: string, ...args: unknown[]): void { this._record(message, args); }
	override error(message: string | Error, ...args: unknown[]): void { this._record(message, args); }
	override critical(message: string | Error, ...args: unknown[]): void { this._record(message, args); }
}

class CountingSecretStorageService extends TestSecretStorageService {
	setCalls = 0;
	deleteCalls = 0;
	override async set(key: string, value: string): Promise<void> {
		this.setCalls++;
		return super.set(key, value);
	}
	override async delete(key: string): Promise<void> {
		this.deleteCalls++;
		return super.delete(key);
	}
	/** Seeds without counting; it still announces the change, as a real store does. */
	async seed(key: string, value: string): Promise<void> {
		await super.set(key, value);
	}
}

type NodeProcess = {
	on(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
	removeListener(event: 'unhandledRejection', listener: (reason: unknown) => void): unknown;
};

/** Runs `run`, lets every pending promise settle, and returns the rejections nobody handled meanwhile. */
async function collectUnhandledRejections(run: () => Promise<void>): Promise<unknown[]> {
	const nodeProcess = (globalThis as unknown as { process?: NodeProcess }).process;
	assert.ok(nodeProcess, 'an unhandled rejection can only be observed under node');
	const seen: unknown[] = [];
	const listener = (reason: unknown) => { seen.push(reason); };
	nodeProcess.on('unhandledRejection', listener);
	try {
		await run();
		await new Promise<void>(resolve => setTimeout(resolve, 20));
	} finally {
		nodeProcess.removeListener('unhandledRejection', listener);
	}
	return seen;
}

suite('Authentication - callers of a stored read that rejects', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();

	suite('runAtBoundary', () => {
		test('a success returns true and reports nothing', async () => {
			const failures: unknown[] = [];
			assert.strictEqual(await runAtBoundary(async () => undefined, e => failures.push(e)), true);
			assert.deepStrictEqual(failures, []);
		});

		test('a failure is reported once, to the handler, and returns false: it never rejects and substitutes nothing', async () => {
			const failure = new InvalidStoredSecretError('k', 'is not valid JSON');
			const failures: unknown[] = [];
			assert.strictEqual(await runAtBoundary(() => Promise.reject(failure), e => failures.push(e)), false);
			assert.deepStrictEqual(failures, [failure]);
		});

		test('a synchronous throw of the operation is reported as well', async () => {
			const failures: unknown[] = [];
			assert.strictEqual(await runAtBoundary(() => { throw new Error('sync'); }, e => failures.push(e)), false);
			assert.strictEqual(failures.length, 1);
		});

		test('a queue that runs it is not poisoned: the next task runs after a failed one', async () => {
			const queue = new Queue<boolean>();
			const ran: string[] = [];
			const failures: unknown[] = [];
			const first = queue.queue(() => runAtBoundary(async () => { ran.push('first'); throw new Error('first fails'); }, e => failures.push(e)));
			const second = queue.queue(() => runAtBoundary(async () => { ran.push('second'); }, e => failures.push(e)));
			assert.deepStrictEqual([await first, await second], [false, true]);
			assert.deepStrictEqual(ran, ['first', 'second']);
			assert.strictEqual(failures.length, 1);
		});

		// The Edit Sessions contribution cannot be constructed without the full workbench: its two boundaries (the start-up
		// resume and the sign-in listener) are runAtBoundary calls, which is what the tests above prove.
	});

	suite('DynamicAuthenticationProviderStorageService secret-change listener', () => {
		const sessionsKey = JSON.stringify({ isDynamicAuthProvider: true, authProviderId: 'p1', clientId: 'c1' });
		const validSession = { access_token: 'tok', token_type: 'Bearer', created_at: 1 };

		/** Constructed first; every value is seeded after construction, so the listener is the one that reads it. */
		function createService(secrets: TestSecretStorageService, logService: RecordingLogService) {
			const service = store.add(new DynamicAuthenticationProviderStorageService(store.add(new TestStorageService()), secrets, logService));
			const events: { authProviderId: string; clientId: string; tokens: unknown }[] = [];
			store.add(service.onDidChangeTokens(e => events.push(e)));
			return { service, events };
		}

		test('a stored session list that cannot be parsed, seeded after construction, is logged and not unhandled; a later valid change is processed', async () => {
			const secrets = new CountingSecretStorageService();
			const logService = new RecordingLogService();
			const { events } = createService(secrets, logService);

			const unhandled = await collectUnhandledRejections(() => secrets.seed(sessionsKey, `${marker} {`));

			assert.deepStrictEqual(unhandled, []);
			assert.deepStrictEqual(events, []);
			assert.ok(logService.logged.some(line => line.includes('InvalidStoredSecretError')), logService.logged.join(' | '));
			assert.ok(logService.logged.every(line => !line.includes(marker)), logService.logged.join(' | '));
			assert.strictEqual(await secrets.get(sessionsKey), `${marker} {`);
			assert.strictEqual(secrets.setCalls, 0);
			assert.strictEqual(secrets.deleteCalls, 0);

			await collectUnhandledRejections(() => secrets.seed(sessionsKey, JSON.stringify([validSession])));
			assert.deepStrictEqual(events, [{ authProviderId: 'p1', clientId: 'c1', tokens: [validSession] }]);
		});

		test('a session list of the wrong shape and an empty one are logged and not unhandled', async () => {
			const secrets = new CountingSecretStorageService();
			const logService = new RecordingLogService();
			const { events } = createService(secrets, logService);

			const unhandled = await collectUnhandledRejections(async () => {
				await secrets.seed(sessionsKey, JSON.stringify([null]));
				await secrets.seed(sessionsKey, '');
			});

			assert.deepStrictEqual(unhandled, []);
			assert.deepStrictEqual(events, []);
			assert.strictEqual(logService.logged.filter(line => line.includes('InvalidStoredSecretError')).length, 2);
			assert.strictEqual(await secrets.get(sessionsKey), '');
		});

		test('a read the secret store refuses (SecretDecryptionError) is logged, not unhandled, and a later read after access is granted is processed', async () => {
			class DeniedSecretStorageService extends CountingSecretStorageService {
				denied = true;
				override async get(key: string): Promise<string | undefined> {
					if (this.denied && key === sessionsKey) {
						throw new SecretDecryptionError(key, 'encryption-service');
					}
					return super.get(key);
				}
			}
			const secrets = new DeniedSecretStorageService();
			const logService = new RecordingLogService();
			const { events } = createService(secrets, logService);

			const unhandled = await collectUnhandledRejections(() => secrets.seed(sessionsKey, JSON.stringify([validSession])));
			assert.deepStrictEqual(unhandled, []);
			assert.deepStrictEqual(events, []);
			assert.ok(logService.logged.some(line => line.includes('SecretDecryptionError')), logService.logged.join(' | '));
			assert.ok(logService.logged.every(line => !line.includes(marker)), logService.logged.join(' | '));

			secrets.denied = false;
			await collectUnhandledRejections(() => secrets.seed(sessionsKey, JSON.stringify([validSession])));
			assert.deepStrictEqual(events, [{ authProviderId: 'p1', clientId: 'c1', tokens: [validSession] }]);
			assert.strictEqual(secrets.deleteCalls, 0);
		});
	});

	suite('ManageAccountsActionImpl', () => {
		const embedderSession = { id: 's1', accessToken: 'tok', providerId: 'p', canSignOut: false };

		class FakeQuickPick {
			readonly onDidAcceptEmitter = new Emitter<void>();
			readonly onDidTriggerButtonEmitter = new Emitter<unknown>();
			readonly onDidHideEmitter = new Emitter<void>();
			readonly onDidAccept = this.onDidAcceptEmitter.event;
			readonly onDidTriggerButton = this.onDidTriggerButtonEmitter.event;
			readonly onDidHide = this.onDidHideEmitter.event;
			items: { label: string }[] = [];
			selectedItems: unknown[] = [];
			title = '';
			placeholder = '';
			buttons: unknown[] = [];
			shown = 0;
			show(): void { this.shown++; }
			hide(): void { this.onDidHideEmitter.fire(); }
			dispose(): void {
				this.onDidAcceptEmitter.dispose();
				this.onDidTriggerButtonEmitter.dispose();
				this.onDidHideEmitter.dispose();
			}
		}

		function create(secrets: TestSecretStorageService) {
			const backButton = { iconClass: 'back' };
			const picks: FakeQuickPick[] = [];
			const quickInput = {
				backButton,
				pick: async (items: unknown[]) => items[0],
				createQuickPick: () => {
					const pick = new FakeQuickPick();
					picks.push(pick);
					return pick;
				}
			};
			const authenticationService = {
				getProviderIds: () => ['p'],
				getProvider: () => ({ id: 'p', label: 'P', authorizationServers: undefined }),
				getAccounts: async () => [{ label: 'Account', id: 'a1' }],
				getSessions: async () => [{ id: 's1', account: { id: 'a1', label: 'Account' } }],
			};
			const notifications: string[] = [];
			const notificationService = { error: (message: string) => notifications.push(message) };
			const logService = new RecordingLogService();
			const impl = new ManageAccountsActionImpl(
				quickInput as unknown as IQuickInputService,
				authenticationService as unknown as IAuthenticationService,
				{ executeCommand: async () => undefined } as unknown as ICommandService,
				secrets,
				productService,
				logService,
				notificationService as unknown as INotificationService,
			);
			return { impl, picks, backButton, notifications, logService };
		}

		test('the back button runs again; a stored session that cannot be read is logged and shown, not unhandled; a later press works', async () => {
			const secrets = new CountingSecretStorageService();
			await secrets.seed(loginKey, JSON.stringify(embedderSession));
			const { impl, picks, backButton, notifications, logService } = create(secrets);

			await impl.run();
			assert.strictEqual(picks.length, 1);
			store.add(picks[0]);
			assert.ok(!picks[0].items.some(item => item.label === 'Sign Out'), 'the embedder says this account cannot sign out');

			await secrets.seed(loginKey, `${marker} {`);
			const unhandled = await collectUnhandledRejections(async () => picks[0].onDidTriggerButtonEmitter.fire(backButton));

			assert.deepStrictEqual(unhandled, []);
			assert.strictEqual(picks.length, 1, 'no quick pick is made over an unreadable session');
			assert.strictEqual(notifications.length, 1);
			assert.ok(!notifications[0].includes(marker));
			assert.ok(logService.logged.some(line => line.includes('InvalidStoredSecretError')), logService.logged.join(' | '));
			assert.ok(logService.logged.every(line => !line.includes(marker)), logService.logged.join(' | '));
			assert.strictEqual(await secrets.get(loginKey), `${marker} {`);
			assert.strictEqual(secrets.deleteCalls, 0);

			// Access is restored: the next press lists the account again, with the sign-out restriction decided from the read.
			await secrets.seed(loginKey, JSON.stringify(embedderSession));
			await collectUnhandledRejections(async () => picks[0].onDidTriggerButtonEmitter.fire(backButton));
			assert.strictEqual(picks.length, 2);
			store.add(picks[1]);
			assert.ok(!picks[1].items.some(item => item.label === 'Sign Out'));
			assert.strictEqual(notifications.length, 1);

			picks[0].hide();
			picks[1].hide();
		});

		test('run() rejects with the named error over an unreadable session, and makes no quick pick: it is never read as "may sign out"', async () => {
			const secrets = new CountingSecretStorageService();
			await secrets.seed(loginKey, `${marker} {`);
			const { impl, picks } = create(secrets);

			await assert.rejects(impl.run(), (e: unknown) => e instanceof InvalidStoredSecretError && e.key === loginKey && !e.message.includes(marker));
			assert.strictEqual(picks.length, 0);
			assert.strictEqual(await secrets.get(loginKey), `${marker} {`);
		});
	});

	// MUST-4: the Accounts menu's account list. The logic lives in AccountsMenuModel so it is testable without the menu.
	suite('AccountsMenuModel', () => {
		const protectedSession: AuthenticationSessionInfo = { id: 's1', accessToken: 'tok', providerId: 'p', canSignOut: false };

		function create(reads: { fail: boolean; count: number }) {
			const authenticationService = {
				getSessions: async (providerId: string) => providerId === 'p' ? [
					{ id: 's1', account: { id: 'a1', label: 'Protected' } },
					{ id: 's2', account: { id: 'a2', label: 'Other' } },
				] : [],
			};
			const logService = new RecordingLogService();
			const model = new AccountsMenuModel(
				authenticationService as unknown as Pick<IAuthenticationService, 'getSessions'>,
				async () => {
					reads.count++;
					if (reads.fail) {
						throw new SecretDecryptionError(loginKey, 'encryption-service');
					}
					return protectedSession;
				},
				logService
			);
			return { model, logService };
		}

		test('a denied embedder read installs no accounts and marks the provider unavailable; the next read on the same model restores the accounts and the sign-out restriction', async () => {
			const reads = { fail: true, count: 0 };
			const { model, logService } = create(reads);

			await model.addAccountsFromProvider('p');
			assert.strictEqual(reads.count, 1);
			assert.strictEqual(model.groupedAccounts.has('p'), false, 'no empty account list is installed before the read succeeded');
			assert.ok(model.problematicProviders.has('p'), 'the failure is visible to the menu');
			assert.ok(logService.logged.some(line => line.includes('SecretDecryptionError')), logService.logged.join(' | '));
			assert.ok(logService.logged.every(line => !line.includes(marker)), logService.logged.join(' | '));

			reads.fail = false;
			await model.addAccountsFromProvider('p');
			assert.strictEqual(reads.count, 2, 'a rejected read is forgotten: the secret store is read again');
			assert.strictEqual(model.problematicProviders.has('p'), false);
			assert.deepStrictEqual(model.groupedAccounts.get('p'), [
				{ id: 'a1', label: 'Protected', canSignOut: false },
				{ id: 'a2', label: 'Other', canSignOut: true },
			]);
		});

		test('an unreadable embedder session is never read as absent: no account is added with permission to sign out', async () => {
			const reads = { fail: true, count: 0 };
			const { model } = create(reads);

			await model.addOrUpdateAccountReportingFailure('p', { id: 'a1', label: 'Protected' });

			assert.strictEqual(model.groupedAccounts.get('p')?.some(account => account.canSignOut) ?? false, false);
			assert.strictEqual(model.groupedAccounts.has('p'), false);
			assert.ok(model.problematicProviders.has('p'));
		});

		test('a failed provider read leaves the accounts of an earlier successful read in place and marks the provider unavailable', async () => {
			let providerFails = false;
			const model = new AccountsMenuModel(
				{
					getSessions: async () => {
						if (providerFails) {
							throw new Error('provider failure');
						}
						return [{ id: 's2', account: { id: 'a2', label: 'Other' } }];
					}
				} as unknown as Pick<IAuthenticationService, 'getSessions'>,
				async () => protectedSession,
				new RecordingLogService()
			);
			await model.addAccountsFromProvider('p');
			const before = JSON.stringify(model.groupedAccounts.get('p'));
			assert.ok(before.includes('a2'));

			providerFails = true;
			await model.addAccountsFromProvider('p');
			assert.ok(model.problematicProviders.has('p'));
			assert.strictEqual(JSON.stringify(model.groupedAccounts.get('p')), before);
		});

		test('a successful read is remembered: it is not repeated for each account', async () => {
			const reads = { fail: false, count: 0 };
			const { model } = create(reads);
			await model.addAccountsFromProvider('p');
			await model.addAccountsFromProvider('p');
			assert.strictEqual(reads.count, 1);
			assert.strictEqual(model.groupedAccounts.get('p')?.length, 2);
		});

		test('removing an account and a provider', async () => {
			const { model } = create({ fail: false, count: 0 });
			await model.addAccountsFromProvider('p');
			model.removeAccount('p', { id: 'a1', label: 'Protected' });
			assert.deepStrictEqual(model.groupedAccounts.get('p')?.map(account => account.id), ['a2']);
			model.removeProvider('p');
			assert.strictEqual(model.groupedAccounts.has('p'), false);
		});
	});
});
