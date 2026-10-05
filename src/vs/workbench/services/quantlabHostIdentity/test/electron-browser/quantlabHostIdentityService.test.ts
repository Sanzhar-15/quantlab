/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry, ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationHandle } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import {
	QUANTLAB_EXT_DID_CHANGE_COMMAND,
	QUANTLAB_EXT_GET_COMMAND,
	QUANTLAB_LEGACY_LOGIN_SECRET_KEYS,
	type QuantlabIdentity,
} from '../../common/quantlabHostIdentity.js';
import { QuantlabHostIdentityService } from '../../electron-browser/quantlabHostIdentityService.js';

class RecordingLogService extends NullLogService {
	readonly errors: string[] = [];
	readonly infos: string[] = [];
	readonly traces: string[] = [];
	override error(message: string | Error): void { this.errors.push(String(message)); }
	override info(message: string): void { this.infos.push(message); }
	override trace(message: string): void { this.traces.push(message); }
}

class RecordingNotificationService extends TestNotificationService {
	readonly notifications: INotification[] = [];
	override notify(notification: INotification): INotificationHandle {
		this.notifications.push(notification);
		return super.notify(notification);
	}
}

class RecordingCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;
	readonly onWillExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly onDidExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly executed: { id: string; args: unknown[] }[] = [];
	failWith: Error | undefined;
	async executeCommand<R = unknown>(id: string, ...args: unknown[]): Promise<R | undefined> {
		this.executed.push({ id, args });
		if (this.failWith) {
			throw this.failWith;
		}
		return undefined;
	}
}

class RecordingSecretStorageService extends Disposable implements ISecretStorageService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeSecret: Event<string> = Event.None;
	readonly type = 'in-memory' as const;
	readonly deleted: string[] = [];
	readonly reads: string[] = [];
	readonly failDelete = new Set<string>();
	async get(key: string): Promise<string | undefined> { this.reads.push(key); return undefined; }
	async set(): Promise<void> { throw new Error('the identity service must never write a secret'); }
	async delete(key: string): Promise<void> {
		if (this.failDelete.has(key)) {
			throw new Error(`delete refused for ${key}`);
		}
		this.deleted.push(key);
	}
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

suite('QuantlabHostIdentityService', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let invokeImpl: () => Promise<unknown>;
	let tickListener: ((payload: unknown) => void) | undefined;
	let invokeCount: number;

	// the transport seams are overridden so no ipcRenderer is touched
	class TestService extends QuantlabHostIdentityService {
		protected override invokeGet(): Promise<unknown> { invokeCount++; return invokeImpl(); }
		protected override listenChanged(listener: (payload: unknown) => void): void { tickListener = listener; }
		whenPurged(): Promise<void> { return this.legacyKeyPurge; }
	}

	let log: RecordingLogService;
	let notifications: RecordingNotificationService;
	let commands: RecordingCommandService;
	let secrets: RecordingSecretStorageService;

	function createService(): TestService {
		return disposables.add(new TestService(log, notifications, commands, secrets));
	}

	const signedIn: QuantlabIdentity = { signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada' } };

	setup(() => {
		invokeImpl = async () => ({ signedIn: false });
		tickListener = undefined;
		invokeCount = 0;
		log = new RecordingLogService();
		notifications = new RecordingNotificationService();
		commands = new RecordingCommandService();
		secrets = disposables.add(new RecordingSecretStorageService());
	});

	test('getIdentity returns the parsed answer of the host', async () => {
		invokeImpl = async () => ({ signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada' } });
		const service = createService();
		await service.whenPurged();

		assert.deepStrictEqual(await service.getIdentity(), signedIn);
		assert.strictEqual(invokeCount, 1);
		assert.deepStrictEqual(log.errors, []);
	});

	test('a rejected invoke is rethrown and logged, never turned into signedIn:false', async () => {
		const failure = new Error('host unavailable');
		invokeImpl = async () => { throw failure; };
		const service = createService();
		await service.whenPurged();

		await assert.rejects(service.getIdentity(), (error: Error) => error === failure);
		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('host unavailable'));
	});

	test('an answer that is not one of the two shapes is rethrown and logged', async () => {
		invokeImpl = async () => ({ signedIn: true });
		const service = createService();
		await service.whenPurged();

		await assert.rejects(service.getIdentity(), /no user object/);
		assert.strictEqual(log.errors.length, 1);
	});

	test('an answer carrying a token field is refused', async () => {
		invokeImpl = async () => ({ signedIn: true, user: { id: 'u1', email: 'a@example.com' }, accessToken: 'SENTINEL-NOT-A-REAL-TOKEN' });
		const service = createService();
		await service.whenPurged();

		await assert.rejects(service.getIdentity(), /unexpected field/);
		assert.ok(!log.errors.join('\n').includes('SENTINEL-NOT-A-REAL-TOKEN'));
	});

	test('a tick fires onDidChangeIdentity once and carries no identity', async () => {
		const service = createService();
		await service.whenPurged();
		let fired = 0;
		disposables.add(service.onDidChangeIdentity(() => fired++));

		assert.ok(tickListener);
		tickListener(null);
		await flush();

		assert.strictEqual(fired, 1);
		assert.strictEqual(invokeCount, 0, 'the service never pulls on its own: consumers do');
		assert.deepStrictEqual(log.errors, []);
	});

	test('a tick executes the extension command, without an argument, when the extension registered it', async () => {
		disposables.add(CommandsRegistry.registerCommand(QUANTLAB_EXT_DID_CHANGE_COMMAND, () => { }));
		const service = createService();
		await service.whenPurged();

		assert.ok(tickListener);
		tickListener(null);
		await flush();

		assert.deepStrictEqual(commands.executed, [{ id: QUANTLAB_EXT_DID_CHANGE_COMMAND, args: [] }]);
	});

	test('a tick calls no extension command when it is not registered (the extension pulls at activation)', async () => {
		const service = createService();
		await service.whenPurged();
		let fired = 0;
		disposables.add(service.onDidChangeIdentity(() => fired++));

		assert.ok(tickListener);
		tickListener(null);
		await flush();

		assert.strictEqual(fired, 1);
		assert.deepStrictEqual(commands.executed, []);
		assert.ok(log.traces.some(line => line.includes('extension not active')));
		assert.deepStrictEqual(log.errors, []);
	});

	test('a failing extension command is logged and shown, and the tick still fired', async () => {
		disposables.add(CommandsRegistry.registerCommand(QUANTLAB_EXT_DID_CHANGE_COMMAND, () => { }));
		commands.failWith = new Error('extension refused');
		const service = createService();
		await service.whenPurged();
		let fired = 0;
		disposables.add(service.onDidChangeIdentity(() => fired++));

		assert.ok(tickListener);
		tickListener(null);
		await flush();

		assert.strictEqual(fired, 1);
		assert.strictEqual(log.errors.length, 1);
		assert.strictEqual(notifications.notifications.length, 1);
		assert.ok(String(notifications.notifications[0].message).includes('extension refused'));
	});

	test('a tick whose payload is not null is logged and shown, and still fires', async () => {
		const service = createService();
		await service.whenPurged();
		let fired = 0;
		disposables.add(service.onDidChangeIdentity(() => fired++));

		assert.ok(tickListener);
		tickListener({ signedIn: false });
		await flush();

		assert.strictEqual(fired, 1);
		assert.strictEqual(log.errors.length, 1);
		assert.strictEqual(notifications.notifications.length, 1);
	});

	test('the extension get command answers with the identity from the service', async () => {
		invokeImpl = async () => ({ signedIn: false });
		const service = createService();
		await service.whenPurged();

		const command = CommandsRegistry.getCommand(QUANTLAB_EXT_GET_COMMAND);
		assert.ok(command, 'the get command must be registered when the service module is loaded');
		const accessor = { get: () => service } as never;
		assert.deepStrictEqual(await command.handler(accessor), { signedIn: false });
	});

	test('start deletes every legacy login key, logs each deletion, and never reads or writes a secret', async () => {
		const service = createService();
		await service.whenPurged();

		assert.deepStrictEqual(secrets.deleted, [...QUANTLAB_LEGACY_LOGIN_SECRET_KEYS]);
		assert.strictEqual(log.infos.length, QUANTLAB_LEGACY_LOGIN_SECRET_KEYS.length);
		for (const key of QUANTLAB_LEGACY_LOGIN_SECRET_KEYS) {
			assert.ok(log.infos.some(line => line.includes(`'${key}'`)), `no log line for ${key}`);
		}
		assert.deepStrictEqual(secrets.reads, []);
		assert.deepStrictEqual(notifications.notifications, []);
	});

	test('a failed deletion is logged and shown, and the other keys are still deleted', async () => {
		secrets.failDelete.add('qic.cloudRefreshToken');
		const service = createService();
		await service.whenPurged();

		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('qic.cloudRefreshToken'));
		assert.strictEqual(notifications.notifications.length, 1);
		assert.ok(String(notifications.notifications[0].message).includes('qic.cloudRefreshToken'));
		assert.deepStrictEqual(secrets.deleted, QUANTLAB_LEGACY_LOGIN_SECRET_KEYS.filter(key => key !== 'qic.cloudRefreshToken'));
	});
});
