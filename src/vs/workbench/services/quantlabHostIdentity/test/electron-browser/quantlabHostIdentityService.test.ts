/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../../base/common/cancellation.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { Event } from '../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationHandle } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { ISecretStorageService } from '../../../../../platform/secrets/common/secrets.js';
import {
	QUANTLAB_HOST_DATA_CANCEL_CHANNEL,
	QUANTLAB_HOST_DATA_REQUEST_CHANNEL,
	QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL,
	QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL,
	QUANTLAB_LEGACY_LOGIN_SECRET_KEYS,
	QuantlabHostError,
	type QuantlabDataFrame,
	type QuantlabHostDataInvokeChannel,
	type QuantlabHostEnvelope,
	type QuantlabIdentity,
} from '../../common/quantlabHostIdentity.js';
import { QuantlabHostIdentityService } from '../../electron-browser/quantlabHostIdentityService.js';

class RecordingLogService extends NullLogService {
	readonly errors: string[] = [];
	readonly infos: string[] = [];
	override error(message: string | Error): void { this.errors.push(String(message)); }
	override info(message: string): void { this.infos.push(message); }
}

class RecordingNotificationService extends TestNotificationService {
	readonly notifications: INotification[] = [];
	override notify(notification: INotification): INotificationHandle {
		this.notifications.push(notification);
		return super.notify(notification);
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
		protected override invokeData(): Promise<unknown> { throw new Error('the identity suite makes no data call'); }
		protected override listenFrames(): void { /* the identity suite sends no frame */ }
		whenPurged(): Promise<void> { return this.legacyKeyPurge; }
	}

	let log: RecordingLogService;
	let notifications: RecordingNotificationService;
	let secrets: RecordingSecretStorageService;

	function createService(): TestService {
		return disposables.add(new TestService(log, notifications, secrets));
	}

	const signedIn: QuantlabIdentity = { epoch: 4, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada', tier: 'pro' } };

	setup(() => {
		invokeImpl = async () => ({ epoch: 1, signedIn: false });
		tickListener = undefined;
		invokeCount = 0;
		log = new RecordingLogService();
		notifications = new RecordingNotificationService();
		secrets = disposables.add(new RecordingSecretStorageService());
	});

	test('getIdentity returns the parsed answer of the host', async () => {
		invokeImpl = async () => ({ epoch: 4, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada', tier: 'pro' } });
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

	// Security-relevant: the epoch is what main's identity-changed check compares; an unchecked one would pass a forged value on.
	// Planted negative control: return `value.epoch` unchecked from parseEpoch and this answer resolves instead of rejecting.
	test('an answer with a malformed epoch is rethrown and logged', async () => {
		invokeImpl = async () => ({ epoch: 0, signedIn: false });
		const service = createService();
		await service.whenPurged();

		await assert.rejects(service.getIdentity(), /epoch is not an integer >= 1/);
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

	// Security-relevant (rule 2, EXT-ISO direct-command case): identity reaches the extension host ONLY through
	// `vscode.quantlabHost`, which the built-in quantlab extension alone receives. A `_quantlab.hostIdentity.*` command
	// would hand the identity to ANY extension (`vscode.commands.executeCommand`), so none may exist once this module
	// has loaded and the service runs.
	// Planted negative control: re-add `CommandsRegistry.registerCommand('_quantlab.hostIdentity.get', accessor =>
	// accessor.get(IQuantlabHostIdentityService).getIdentity());` at the bottom of quantlabHostIdentityService.ts and
	// both assertions fail.
	test('no _quantlab.hostIdentity command is registered (EXT-ISO direct command)', async () => {
		const service = createService();
		await service.whenPurged();

		assert.strictEqual(CommandsRegistry.getCommand('_quantlab.hostIdentity.get'), undefined);
		const leaked = [...CommandsRegistry.getCommands().keys()].filter(id => id.startsWith('_quantlab.hostIdentity'));
		assert.deepStrictEqual(leaked, []);
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

suite('QuantlabHostIdentityService - data', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	type DataCall = { channel: QuantlabHostDataInvokeChannel; envelope: QuantlabHostEnvelope<unknown> };

	let dataImpl: (call: DataCall) => Promise<unknown>;
	let dataCalls: DataCall[];
	let frameListener: ((payload: unknown) => void) | undefined;

	// every transport seam is overridden so no ipcRenderer is touched
	class TestService extends QuantlabHostIdentityService {
		protected override invokeGet(): Promise<unknown> { throw new Error('the data suite makes no identity call'); }
		protected override listenChanged(): void { /* the data suite sends no tick */ }
		protected override invokeData(channel: QuantlabHostDataInvokeChannel, envelope: QuantlabHostEnvelope<unknown>): Promise<unknown> {
			const call = { channel, envelope };
			dataCalls.push(call);
			return dataImpl(call);
		}
		protected override listenFrames(listener: (payload: unknown) => void): void { frameListener = listener; }
		whenPurged(): Promise<void> { return this.legacyKeyPurge; }
	}

	let log: RecordingLogService;

	async function createService(): Promise<TestService> {
		const service = disposables.add(new TestService(log, new RecordingNotificationService(), disposables.add(new RecordingSecretStorageService())));
		await service.whenPurged();
		return service;
	}

	function sendFrame(payload: unknown): void {
		assert.ok(frameListener, 'the service must listen for frames at construction');
		frameListener(payload);
	}

	function received(service: TestService): QuantlabDataFrame[] {
		const frames: QuantlabDataFrame[] = [];
		disposables.add(service.onDidReceiveFrame(frame => frames.push(frame)));
		return frames;
	}

	const unknownHandleLines = () => log.infos.filter(line => line.includes('frame for unknown handle'));

	setup(() => {
		dataImpl = async () => { throw new Error('no data answer was planted for this test'); };
		dataCalls = [];
		frameListener = undefined;
		log = new RecordingLogService();
	});

	test('request sends the envelope on the request channel and resolves with the data', async () => {
		dataImpl = async () => ({ ok: true, data: { bars: [1, 2] } });
		const service = await createService();

		assert.deepStrictEqual(await service.request('bars', { symbol: 'X' }, 3, CancellationToken.None), { bars: [1, 2] });
		assert.deepStrictEqual(dataCalls, [{ channel: QUANTLAB_HOST_DATA_REQUEST_CHANNEL, envelope: { v: 1, input: { id: '1', op: 'bars', input: { symbol: 'X' }, epoch: 3 } } }]);
		assert.deepStrictEqual(log.errors, []);
	});

	test('request ids are unique per service', async () => {
		dataImpl = async () => ({ ok: true, data: null });
		const service = await createService();

		await service.request('a', null, 1, CancellationToken.None);
		await service.request('a', null, 1, CancellationToken.None);
		await service.request('b', null, 1, CancellationToken.None);

		const ids = dataCalls.map(call => (call.envelope.input as { id: string }).id);
		assert.strictEqual(new Set(ids).size, 3);
	});

	// Security-relevant: a refusal (identity-changed, not-signed-in, ...) must never become data the caller acts on.
	// Planted negative control: make unwrapAnswer `return undefined` for `ok: false` and assert.rejects fails.
	test('a refusal rejects with its code and status, never a value', async () => {
		dataImpl = async () => ({ ok: false, code: 'server', message: 'bad gateway', status: 502 });
		const service = await createService();

		await assert.rejects(service.request('bars', null, 1, CancellationToken.None), (error: Error) => {
			assert.ok(error instanceof QuantlabHostError);
			assert.strictEqual(error.code, 'server');
			assert.strictEqual(error.status, 502);
			assert.strictEqual(error.message, 'bad gateway');
			return true;
		});

		dataImpl = async () => ({ ok: false, code: 'identity-changed', message: 'stale epoch' });
		await assert.rejects(service.request('bars', null, 1, CancellationToken.None), (error: Error) => error instanceof QuantlabHostError && error.code === 'identity-changed');
		assert.deepStrictEqual(log.errors, []);
		assert.strictEqual(log.infos.filter(line => line.includes('refused by the host')).length, 2);
	});

	// Planted negative control: remove the token.onCancellationRequested listener in request() and the cancel-call assertion fails.
	test('cancellation sends cancel for the same id, and the request rejects cancelled', async () => {
		let answerRequest: ((answer: unknown) => void) | undefined;
		dataImpl = async call => {
			if (call.channel === QUANTLAB_HOST_DATA_REQUEST_CHANNEL) {
				return new Promise<unknown>(resolve => answerRequest = resolve);
			}
			assert.ok(answerRequest);
			answerRequest({ ok: false, code: 'cancelled', message: 'cancelled' });
			return null;
		};
		const service = await createService();
		const source = disposables.add(new CancellationTokenSource());

		const pending = service.request('bars', null, 1, source.token);
		await flush();
		source.cancel();

		assert.strictEqual(dataCalls.length, 2);
		const id = (dataCalls[0].envelope.input as { id: string }).id;
		assert.deepStrictEqual(dataCalls[1], { channel: QUANTLAB_HOST_DATA_CANCEL_CHANNEL, envelope: { v: 1, input: { id } } });
		await assert.rejects(pending, (error: Error) => error instanceof QuantlabHostError && error.code === 'cancelled');
		await flush();
		assert.deepStrictEqual(log.errors, []);
	});

	test('a request whose token is already cancelled sends nothing and rejects cancelled', async () => {
		const service = await createService();
		const source = disposables.add(new CancellationTokenSource());
		source.cancel();

		await assert.rejects(service.request('bars', null, 1, source.token), (error: Error) => error instanceof QuantlabHostError && error.code === 'cancelled');
		assert.deepStrictEqual(dataCalls, []);
	});

	test('cancelling after the answer sends no cancel', async () => {
		dataImpl = async () => ({ ok: true, data: 1 });
		const service = await createService();
		const source = disposables.add(new CancellationTokenSource());

		assert.strictEqual(await service.request('bars', null, 1, source.token), 1);
		source.cancel();
		assert.strictEqual(dataCalls.length, 1);
	});

	test('a cancel answered with something other than null is logged', async () => {
		let answerRequest: ((answer: unknown) => void) | undefined;
		dataImpl = async call => {
			if (call.channel === QUANTLAB_HOST_DATA_REQUEST_CHANNEL) {
				return new Promise<unknown>(resolve => answerRequest = resolve);
			}
			return { ok: true };
		};
		const service = await createService();
		const source = disposables.add(new CancellationTokenSource());

		const pending = service.request('bars', null, 1, source.token);
		await flush();
		source.cancel();
		await flush();

		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('other than null'));
		assert.ok(answerRequest);
		answerRequest({ ok: false, code: 'cancelled', message: 'cancelled' });
		await assert.rejects(pending, (error: Error) => error instanceof QuantlabHostError && error.code === 'cancelled');
	});

	test('a rejected invoke is rethrown and logged', async () => {
		const failure = new Error('no handler for the channel');
		dataImpl = async () => { throw failure; };
		const service = await createService();

		await assert.rejects(service.request('bars', null, 1, CancellationToken.None), (error: Error) => error === failure);
		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('no handler for the channel'));
	});

	// Security-relevant: an answer that breaks the contract (a smuggled token among them) must reject, not resolve.
	// Planted negative control: make unwrapAnswer return `(raw as { data: unknown }).data` without parseHostAnswer and these resolve.
	test('a malformed answer rejects visibly, is logged, and never echoes a smuggled value', async () => {
		const secret = 'SENTINEL-NOT-A-REAL-TOKEN';
		const service = await createService();
		const answers: unknown[] = [null, 'ok', { ok: true }, { ok: 'yes', data: 1 }, { ok: false, code: 'teapot', message: 'm' }, { ok: false, code: 'server', message: 'm' }, { ok: true, data: 1, token: secret }];
		for (const answer of answers) {
			dataImpl = async () => answer;
			await assert.rejects(service.request('bars', null, 1, CancellationToken.None), (error: Error) => !(error instanceof QuantlabHostError), `answer: ${JSON.stringify(answer)}`);
		}
		assert.strictEqual(log.errors.length, answers.length);
		assert.ok(!log.errors.join('\n').includes(secret));
	});

	test('subscribe sends the envelope, and its frames reach onDidReceiveFrame in order', async () => {
		dataImpl = async () => ({ ok: true, data: null });
		const service = await createService();
		const frames = received(service);

		await service.subscribe(4, 'ticks', { symbol: 'X' }, 2);
		sendFrame({ handle: 4, epoch: 2, kind: 'state', state: { kind: 'open' } });
		sendFrame({ handle: 4, epoch: 2, kind: 'data', data: { p: 1 } });

		assert.deepStrictEqual(dataCalls, [{ channel: QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL, envelope: { v: 1, input: { handle: 4, topic: 'ticks', params: { symbol: 'X' }, epoch: 2 } } }]);
		assert.deepStrictEqual(frames, [
			{ handle: 4, epoch: 2, kind: 'state', state: { kind: 'open' } },
			{ handle: 4, epoch: 2, kind: 'data', data: { p: 1 } },
		]);
		assert.deepStrictEqual(log.errors, []);
	});

	test('a frame that arrives before the subscribe answer is delivered', async () => {
		let answerSubscribe: ((answer: unknown) => void) | undefined;
		dataImpl = async () => new Promise<unknown>(resolve => answerSubscribe = resolve);
		const service = await createService();
		const frames = received(service);

		const pending = service.subscribe(4, 'ticks', null, 2);
		sendFrame({ handle: 4, epoch: 2, kind: 'state', state: { kind: 'open' } });
		await flush();
		assert.ok(answerSubscribe);
		answerSubscribe({ ok: true, data: null });
		await pending;

		assert.strictEqual(frames.length, 1);
	});

	test('a subscribe answered with data rejects visibly and releases the handle', async () => {
		dataImpl = async () => ({ ok: true, data: { unexpected: true } });
		const service = await createService();

		await assert.rejects(service.subscribe(4, 'ticks', null, 2), /the contract says null/);
		assert.strictEqual(log.errors.length, 1);
		assert.throws(() => service.unsubscribe(4), /not subscribed/);
	});

	test('a refused subscribe rejects with its code and releases the handle', async () => {
		dataImpl = async () => ({ ok: false, code: 'not-signed-in', message: 'signed out' });
		const service = await createService();
		const frames = received(service);

		await assert.rejects(service.subscribe(4, 'ticks', null, 2), (error: Error) => error instanceof QuantlabHostError && error.code === 'not-signed-in');
		sendFrame({ handle: 4, epoch: 2, kind: 'data', data: 1 });
		assert.deepStrictEqual(frames, []);

		dataImpl = async () => ({ ok: true, data: null });
		await service.subscribe(4, 'ticks', null, 2);
	});

	test('subscribing a handle twice is refused', async () => {
		dataImpl = async () => ({ ok: true, data: null });
		const service = await createService();

		await service.subscribe(4, 'ticks', null, 2);
		await assert.rejects(service.subscribe(4, 'ticks', null, 2), /already subscribed/);
		assert.strictEqual(dataCalls.length, 1);
	});

	test('unsubscribe sends the envelope and ends delivery', async () => {
		dataImpl = async () => ({ ok: true, data: null });
		const service = await createService();
		const frames = received(service);

		await service.subscribe(4, 'ticks', null, 2);
		dataImpl = async () => null;
		service.unsubscribe(4);
		sendFrame({ handle: 4, epoch: 2, kind: 'data', data: 1 });
		await flush();

		assert.deepStrictEqual(dataCalls[1], { channel: QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL, envelope: { v: 1, input: { handle: 4 } } });
		assert.deepStrictEqual(frames, []);
		assert.strictEqual(unknownHandleLines().length, 1);
		assert.deepStrictEqual(log.errors, []);
		assert.throws(() => service.unsubscribe(4), /not subscribed/);
	});

	test('a closed state frame is delivered and ends the subscription', async () => {
		dataImpl = async () => ({ ok: true, data: null });
		const service = await createService();
		const frames = received(service);

		await service.subscribe(4, 'ticks', null, 2);
		sendFrame({ handle: 4, epoch: 2, kind: 'state', state: { kind: 'closed', message: 'identity-changed' } });
		sendFrame({ handle: 4, epoch: 2, kind: 'data', data: 1 });

		assert.deepStrictEqual(frames, [{ handle: 4, epoch: 2, kind: 'state', state: { kind: 'closed', message: 'identity-changed' } }]);
		assert.throws(() => service.unsubscribe(4), /not subscribed/);
		assert.strictEqual(dataCalls.length, 1, 'no unsubscribe is sent for a subscription the host ended');
	});

	// Security-relevant: frames are only delivered for handles this window subscribed.
	// Planted negative control: drop the openHandles check in onFrame and `frames` is no longer empty.
	test('a frame for an unknown handle is logged once and dropped', async () => {
		const service = await createService();
		const frames = received(service);

		sendFrame({ handle: 9, epoch: 1, kind: 'data', data: 1 });

		assert.deepStrictEqual(frames, []);
		assert.strictEqual(unknownHandleLines().length, 1);
		assert.ok(unknownHandleLines()[0].includes('9'));
	});

	test('a malformed frame is logged as an error and not delivered', async () => {
		dataImpl = async () => ({ ok: true, data: null });
		const service = await createService();
		const frames = received(service);

		await service.subscribe(4, 'ticks', null, 2);
		sendFrame({ handle: 4, epoch: 0, kind: 'data', data: 1 });
		sendFrame({ handle: 4, epoch: 2, kind: 'data', data: 1, token: 'SENTINEL-NOT-A-REAL-TOKEN' });

		assert.deepStrictEqual(frames, []);
		assert.strictEqual(log.errors.length, 2);
		assert.ok(!log.errors.join('\n').includes('SENTINEL-NOT-A-REAL-TOKEN'));
	});
});
