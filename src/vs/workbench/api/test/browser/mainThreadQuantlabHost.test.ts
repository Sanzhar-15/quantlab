/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken, CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { IQuantlabHostIdentityService, QuantlabDataFrame, QuantlabHostError, QuantlabIdentity } from '../../../services/quantlabHostIdentity/common/quantlabHostIdentity.js';
import { MainThreadQuantlabHost } from '../../browser/mainThreadQuantlabHost.js';
import { ExtHostQuantlabHostShape, QuantlabIdentityDto, QuantlabSubscriptionStateDto } from '../../common/extHost.protocol.js';
import { SingleProxyRPCProtocol } from '../common/testRPCProtocol.js';

class RecordingLogService extends NullLogService {
	readonly errors: string[] = [];
	readonly infos: string[] = [];
	override error(message: string | Error): void { this.errors.push(String(message)); }
	override info(message: string): void { this.infos.push(message); }
}

class FakeHostService extends Disposable implements IQuantlabHostIdentityService {
	declare readonly _serviceBrand: undefined;

	readonly identityTick = this._register(new Emitter<void>());
	readonly onDidChangeIdentity = this.identityTick.event;
	readonly frames = this._register(new Emitter<QuantlabDataFrame>());
	readonly onDidReceiveFrame = this.frames.event;

	identity: QuantlabIdentity = { epoch: 1, signedIn: false };
	requestImpl: () => Promise<unknown> = async () => { throw new Error('no request answer was planted for this test'); };
	subscribeImpl: () => Promise<void> = async () => { };
	signOutImpl: () => Promise<boolean> = async () => { throw new Error('no sign-out answer was planted for this test'); };
	signOuts = 0;
	readonly requests: { op: string; input: unknown; epoch: number; token: CancellationToken }[] = [];
	readonly subscribed: { handle: number; topic: string; params: unknown; epoch: number }[] = [];
	readonly unsubscribed: number[] = [];

	async getIdentity(): Promise<QuantlabIdentity> { return this.identity; }
	signOut(): Promise<boolean> {
		this.signOuts++;
		return this.signOutImpl();
	}
	request(op: string, input: unknown, epoch: number, token: CancellationToken): Promise<unknown> {
		this.requests.push({ op, input, epoch, token });
		return this.requestImpl();
	}
	subscribe(handle: number, topic: string, params: unknown, epoch: number): Promise<void> {
		this.subscribed.push({ handle, topic, params, epoch });
		return this.subscribeImpl();
	}
	unsubscribe(handle: number): void { this.unsubscribed.push(handle); }
}

class RecordingProxy implements ExtHostQuantlabHostShape {
	readonly identities: QuantlabIdentityDto[] = [];
	readonly data: [number, unknown, number][] = [];
	readonly states: [number, QuantlabSubscriptionStateDto, number][] = [];
	$onDidChangeIdentity(identity: QuantlabIdentityDto): void { this.identities.push(identity); }
	$onData(handle: number, data: unknown, epoch: number): void { this.data.push([handle, data, epoch]); }
	$onState(handle: number, state: QuantlabSubscriptionStateDto, epoch: number): void { this.states.push([handle, state, epoch]); }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

suite('MainThreadQuantlabHost', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let service: FakeHostService;
	let proxy: RecordingProxy;
	let log: RecordingLogService;

	function createCustomer(): MainThreadQuantlabHost {
		return disposables.add(new MainThreadQuantlabHost(SingleProxyRPCProtocol(proxy), service, log));
	}

	setup(() => {
		service = disposables.add(new FakeHostService());
		proxy = new RecordingProxy();
		log = new RecordingLogService();
	});

	test('$getIdentity passes the epoch and exactly the DTO fields through', async () => {
		const customer = createCustomer();

		assert.deepStrictEqual(await customer.$getIdentity(), { epoch: 1, signedIn: false });
		service.identity = { epoch: 7, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada', tier: 'pro' } };
		assert.deepStrictEqual(await customer.$getIdentity(), { epoch: 7, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada', tier: 'pro' } });
	});

	test('$getIdentity sends a signed-in user without a name with no name field', async () => {
		const customer = createCustomer();
		service.identity = { epoch: 2, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: undefined, tier: 'pro' } };

		assert.deepStrictEqual(await customer.$getIdentity(), { epoch: 2, signedIn: true, user: { id: 'u1', email: 'a@example.com', tier: 'pro' } });
	});

	test('an identity tick pushes the freshly pulled identity to the extension host', async () => {
		createCustomer();
		service.identity = { epoch: 3, signedIn: true, user: { id: 'u2', email: 'b@example.com', name: 'Bo', tier: 'pro' } };

		service.identityTick.fire();
		await flush();

		assert.deepStrictEqual(proxy.identities, [{ epoch: 3, signedIn: true, user: { id: 'u2', email: 'b@example.com', name: 'Bo', tier: 'pro' } }]);
	});

	test('a tick whose pull fails is logged and pushes nothing', async () => {
		createCustomer();
		service.getIdentity = async () => { throw new Error('host unavailable'); };

		service.identityTick.fire();
		await flush();

		assert.deepStrictEqual(proxy.identities, []);
		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('host unavailable'));
	});

	// Security-relevant: the caller's epoch is what lets main refuse a call made for a previous identity.
	// Planted negative control: pass `(await this._hostService.getIdentity()).epoch` instead of `epoch` in $request and the epoch assertion fails.
	test('$request passes op, input, the caller epoch and the token through, and answers { ok: true, data }', async () => {
		const customer = createCustomer();
		service.identity = { epoch: 5, signedIn: false };
		service.requestImpl = async () => ({ bars: [1] });
		const source = disposables.add(new CancellationTokenSource());

		assert.deepStrictEqual(await customer.$request('bars', { symbol: 'X' }, 3, source.token), { ok: true, data: { bars: [1] } });
		assert.strictEqual(service.requests.length, 1);
		assert.strictEqual(service.requests[0].op, 'bars');
		assert.deepStrictEqual(service.requests[0].input, { symbol: 'X' });
		assert.strictEqual(service.requests[0].epoch, 3);
		assert.strictEqual(service.requests[0].token, source.token);
	});

	// Security-relevant: a refusal must reach the extension as a refusal (never as data), status included.
	// Planted negative control: return `{ ok: true, data: undefined }` from _refusalOrThrow for a QuantlabHostError and both assertions fail.
	test('$request answers a host refusal as ok:false with code, message and status, and the status survives the wire', async () => {
		const customer = createCustomer();
		service.requestImpl = async () => { throw new QuantlabHostError('server', 'bad gateway', 502); };

		const answer = await customer.$request('bars', null, 1, CancellationToken.None);
		assert.deepStrictEqual(answer, { ok: false, code: 'server', message: 'bad gateway', status: 502 });
		assert.deepStrictEqual(JSON.parse(JSON.stringify(answer)), { ok: false, code: 'server', message: 'bad gateway', status: 502 });

		service.requestImpl = async () => { throw new QuantlabHostError('identity-changed', 'stale', undefined); };
		assert.deepStrictEqual(await customer.$request('bars', null, 1, CancellationToken.None), { ok: false, code: 'identity-changed', message: 'stale' });
		assert.deepStrictEqual(log.errors, []);
	});

	// Planted negative control: map every error to ok:false in _refusalOrThrow and assert.rejects fails.
	test('$request rejects, and logs, an error that is not a host answer', async () => {
		const customer = createCustomer();
		const failure = new Error('malformed answer');
		service.requestImpl = async () => { throw failure; };

		await assert.rejects(customer.$request('bars', null, 1, CancellationToken.None), (error: Error) => error === failure);
		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('malformed answer'));
	});

	test('frames for a subscription reach $onData and $onState under the extension host handle, with their epoch', async () => {
		const customer = createCustomer();

		assert.deepStrictEqual(await customer.$subscribe(7, 'ticks', { symbol: 'X' }, 2), { ok: true, data: null });
		assert.strictEqual(service.subscribed.length, 1);
		const serviceHandle = service.subscribed[0].handle;
		assert.deepStrictEqual({ ...service.subscribed[0], handle: 0 }, { handle: 0, topic: 'ticks', params: { symbol: 'X' }, epoch: 2 });

		service.frames.fire({ handle: serviceHandle, epoch: 2, kind: 'state', state: { kind: 'open' } });
		service.frames.fire({ handle: serviceHandle, epoch: 2, kind: 'data', data: { p: 1 } });

		assert.deepStrictEqual(proxy.states, [[7, { kind: 'open' }, 2]]);
		assert.deepStrictEqual(proxy.data, [[7, { p: 1 }, 2]]);
	});

	test('two customers never route each other\'s frames, even for the same extension host handle', async () => {
		const first = createCustomer();
		const secondProxy = new RecordingProxy();
		const second = disposables.add(new MainThreadQuantlabHost(SingleProxyRPCProtocol(secondProxy), service, log));

		await first.$subscribe(1, 'ticks', null, 1);
		await second.$subscribe(1, 'ticks', null, 1);
		const [firstHandle, secondHandle] = service.subscribed.map(entry => entry.handle);
		assert.notStrictEqual(firstHandle, secondHandle);

		service.frames.fire({ handle: secondHandle, epoch: 1, kind: 'data', data: 'two' });

		assert.deepStrictEqual(proxy.data, []);
		assert.deepStrictEqual(secondProxy.data, [[1, 'two', 1]]);
	});

	test('a closed state frame is forwarded and forgets the subscription; a later $unsubscribe sends nothing', async () => {
		const customer = createCustomer();

		await customer.$subscribe(7, 'ticks', null, 2);
		const serviceHandle = service.subscribed[0].handle;
		service.frames.fire({ handle: serviceHandle, epoch: 2, kind: 'state', state: { kind: 'closed', message: 'identity-changed' } });
		customer.$unsubscribe(7);

		assert.deepStrictEqual(proxy.states, [[7, { kind: 'closed', message: 'identity-changed' }, 2]]);
		assert.deepStrictEqual(service.unsubscribed, []);
		assert.strictEqual(log.infos.length, 1);
	});

	// Both terminal kinds forget the handle, whatever their epoch: an old-epoch frame that crosses a new identity is forwarded
	// (the extension host decides what to deliver) but must still release the handle, or nothing would ever end it.
	// Planted negative control: restore `frame.state.kind === 'closed'` alone in _routeFrame: the 'error' run keeps the handle and
	// $unsubscribe sends one unsubscribe to the service.
	for (const kind of ['closed', 'error'] as const) {
		test(`an old-epoch '${kind}' state frame after a new identity is forwarded and forgets the subscription; a later $unsubscribe sends nothing`, async () => {
			const customer = createCustomer();

			await customer.$subscribe(7, 'ticks', null, 1);
			const serviceHandle = service.subscribed[0].handle;
			service.identity = { epoch: 2, signedIn: false };
			service.identityTick.fire();
			await flush();
			service.frames.fire({ handle: serviceHandle, epoch: 1, kind: 'state', state: { kind, message: 'review-ended' } });
			customer.$unsubscribe(7);

			assert.deepStrictEqual(proxy.identities, [{ epoch: 2, signedIn: false }]);
			assert.deepStrictEqual(proxy.states, [[7, { kind, message: 'review-ended' }, 1]]);
			assert.deepStrictEqual(service.unsubscribed, []);
			assert.strictEqual(log.infos.length, 1);
		});
	}

	test('a non-terminal state frame keeps the subscription: a later $unsubscribe ends it at the service', async () => {
		const customer = createCustomer();

		await customer.$subscribe(7, 'ticks', null, 1);
		const serviceHandle = service.subscribed[0].handle;
		service.frames.fire({ handle: serviceHandle, epoch: 1, kind: 'state', state: { kind: 'reconnecting' } });
		customer.$unsubscribe(7);

		assert.deepStrictEqual(service.unsubscribed, [serviceHandle]);
	});

	test('a refused $subscribe answers ok:false and leaves the handle free', async () => {
		const customer = createCustomer();
		service.subscribeImpl = async () => { throw new QuantlabHostError('not-signed-in', 'signed out', undefined); };

		assert.deepStrictEqual(await customer.$subscribe(7, 'ticks', null, 2), { ok: false, code: 'not-signed-in', message: 'signed out' });

		service.subscribeImpl = async () => { };
		assert.deepStrictEqual(await customer.$subscribe(7, 'ticks', null, 2), { ok: true, data: null });
		assert.strictEqual(service.subscribed.length, 2);
	});

	test('a $subscribe that fails without a host answer rejects, is logged, and leaves the handle free', async () => {
		const customer = createCustomer();
		const failure = new Error('no handler for the channel');
		service.subscribeImpl = async () => { throw failure; };

		await assert.rejects(customer.$subscribe(7, 'ticks', null, 2), (error: Error) => error === failure);
		assert.strictEqual(log.errors.length, 1);

		service.subscribeImpl = async () => { };
		assert.deepStrictEqual(await customer.$subscribe(7, 'ticks', null, 2), { ok: true, data: null });
	});

	test('$subscribe of a handle already open is refused', async () => {
		const customer = createCustomer();

		await customer.$subscribe(7, 'ticks', null, 2);
		await assert.rejects(customer.$subscribe(7, 'ticks', null, 2), /already subscribed/);
		assert.strictEqual(service.subscribed.length, 1);
	});

	test('$unsubscribe ends the service subscription', async () => {
		const customer = createCustomer();

		await customer.$subscribe(7, 'ticks', null, 2);
		customer.$unsubscribe(7);

		assert.deepStrictEqual(service.unsubscribed, [service.subscribed[0].handle]);
	});

	// Planted negative control: delete the loop in dispose() and `unsubscribed` stays empty.
	test('disposing the customer unsubscribes every subscription of its extension host', async () => {
		const customer = createCustomer();

		await customer.$subscribe(1, 'ticks', null, 2);
		await customer.$subscribe(2, 'bars', null, 2);
		await customer.$subscribe(3, 'ticks', null, 2);
		customer.$unsubscribe(2);
		const open = [service.subscribed[0].handle, service.subscribed[2].handle];
		customer.dispose();

		assert.deepStrictEqual(service.unsubscribed.slice(1), open);
		service.frames.fire({ handle: open[0], epoch: 2, kind: 'data', data: 1 });
		assert.deepStrictEqual(proxy.data, []);
	});

	test('$signOut answers { ok: true, data } with the service\'s boolean', async () => {
		const customer = createCustomer();

		service.signOutImpl = async () => true;
		assert.deepStrictEqual(await customer.$signOut(), { ok: true, data: true });
		service.signOutImpl = async () => false;
		assert.deepStrictEqual(await customer.$signOut(), { ok: true, data: false });
		assert.strictEqual(service.signOuts, 2);
	});

	test('$signOut answers a host refusal as ok:false with its code and status', async () => {
		const customer = createCustomer();
		service.signOutImpl = async () => { throw new QuantlabHostError('server', 'logout failed', 502); };

		assert.deepStrictEqual(await customer.$signOut(), { ok: false, code: 'server', message: 'logout failed', status: 502 });
		assert.deepStrictEqual(log.errors, []);
	});

	test('$signOut rejects and logs a failure that is not a host answer', async () => {
		const customer = createCustomer();
		const failure = new Error('no handler for the channel');
		service.signOutImpl = async () => { throw failure; };

		await assert.rejects(customer.$signOut(), (error: Error) => error === failure);
		assert.strictEqual(log.errors.length, 1);
		assert.ok(log.errors[0].includes('no handler for the channel'));
	});
});
