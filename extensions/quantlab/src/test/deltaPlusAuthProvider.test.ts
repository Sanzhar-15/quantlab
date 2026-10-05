/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { installVscodeShim, _errorMessagesSnapshot, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();

import 'mocha';
import * as assert from 'assert';
import * as vscode from 'vscode';
import { DeltaPlusAuthProvider, HOST_IDENTITY_UNAVAILABLE } from '../auth/DeltaPlusAuthProvider';
import type { ServerApiClient, ServerUser } from '../core/server/ServerApiClient';

// QL-LOGIN / rule 2: DeltaPlusAuthProvider reads the identity ONLY from vscode.quantlabHost -- a pull of
// getIdentity() at start, then every identity onDidChangeIdentity delivers. The host API is stubbed on the
// shimmed vscode module (the serverApiTransport.test.ts style); ServerApiClient is replaced by a recorder.

interface Deferred {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

class FakeHost {
	private readonly _changes = new vscode.EventEmitter<vscode.QuantlabHostIdentity>();
	readonly onDidChangeIdentity = this._changes.event;
	/** One entry per getIdentity() call, settled by the test. */
	readonly pulls: Deferred[] = [];

	getIdentity(): Promise<unknown> {
		return new Promise<unknown>((resolve, reject) => this.pulls.push({ resolve, reject }));
	}

	request(): Promise<unknown> {
		return Promise.reject(new Error('the identity suite makes no data call'));
	}

	subscribe(): never {
		throw new Error('the identity suite opens no subscription');
	}

	fire(identity: unknown): void {
		this._changes.fire(identity as vscode.QuantlabHostIdentity);
	}
}

class RecordingClient {
	readonly applied: (ServerUser | undefined)[] = [];
	setHostIdentity(user: ServerUser | undefined): void {
		this.applied.push(user);
	}
}

function setHost(host: unknown): void {
	(vscode as unknown as { quantlabHost?: unknown }).quantlabHost = host;
}

function clearHost(): void {
	delete (vscode as unknown as { quantlabHost?: unknown }).quantlabHost;
}

function fakeContext(): vscode.ExtensionContext {
	return { secrets: { delete: async (): Promise<void> => undefined } } as unknown as vscode.ExtensionContext;
}

/** Lets every pending promise continuation run (the legacy-key purge precedes the pull). */
const settle = (): Promise<void> => new Promise<void>(resolve => setImmediate(resolve));

suite('DeltaPlusAuthProvider reads the identity through vscode.quantlabHost', () => {
	let host: FakeHost;
	let client: RecordingClient;
	let provider: DeltaPlusAuthProvider | undefined;
	let signIns: number;

	function createProvider(): DeltaPlusAuthProvider {
		const created = new DeltaPlusAuthProvider(fakeContext(), client as unknown as ServerApiClient);
		created.onDidSignIn(() => signIns++);
		provider = created;
		return created;
	}

	/**
	 * Starts initializeFromHost and waits until its one pull reached the host. The pending result is
	 * returned wrapped: an async function returning the bare promise would wait for it to settle.
	 */
	async function startInitialize(target: DeltaPlusAuthProvider): Promise<{ readonly result: Promise<boolean> }> {
		const result = target.initializeFromHost();
		await settle();
		assert.strictEqual(host.pulls.length, 1, 'initializeFromHost must pull from vscode.quantlabHost once');
		return { result };
	}

	setup(() => {
		_resetShimState();
		host = new FakeHost();
		client = new RecordingClient();
		provider = undefined;
		signIns = 0;
		setHost(host);
	});

	teardown(() => {
		provider?.dispose();
		clearHost();
	});

	test('the start-up pull applies the identity from vscode.quantlabHost.getIdentity()', async () => {
		const { result: pending } = await startInitialize(createProvider());
		host.pulls[0].resolve({ epoch: 3, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada Lovelace' } });

		assert.strictEqual(await pending, true);
		assert.deepStrictEqual(client.applied, [{ id: 'u1', email: 'a@example.com', name: 'Ada Lovelace' }]);
		assert.strictEqual(signIns, 1);
		assert.deepStrictEqual(_errorMessagesSnapshot(), []);
	});

	test('a nameless user is accepted and no name is invented', async () => {
		const { result: pending } = await startInitialize(createProvider());
		host.pulls[0].resolve({ epoch: 2, signedIn: true, user: { id: 'u1', email: 'a@example.com' } });

		assert.strictEqual(await pending, true);
		assert.deepStrictEqual(client.applied, [{ id: 'u1', email: 'a@example.com' }]);
		assert.ok(!Object.prototype.hasOwnProperty.call(client.applied[0], 'name'), 'an absent name must stay absent, not become a key');
		assert.deepStrictEqual(_errorMessagesSnapshot(), []);
	});

	test('an onDidChangeIdentity event updates the state without another pull', async () => {
		const { result: pending } = await startInitialize(createProvider());
		host.pulls[0].resolve({ epoch: 1, signedIn: false });
		assert.strictEqual(await pending, false);

		host.fire({ epoch: 2, signedIn: true, user: { id: 'u2', email: 'b@example.com', name: 'Bo' } });
		assert.deepStrictEqual(client.applied[client.applied.length - 1], { id: 'u2', email: 'b@example.com', name: 'Bo' });
		assert.strictEqual(signIns, 1);

		host.fire({ epoch: 3, signedIn: false });
		assert.strictEqual(client.applied[client.applied.length - 1], undefined);
		assert.deepStrictEqual(client.applied, [undefined, { id: 'u2', email: 'b@example.com', name: 'Bo' }, undefined]);
		assert.strictEqual(host.pulls.length, 1, 'an event carries the identity: the provider does not pull for it');
		assert.deepStrictEqual(_errorMessagesSnapshot(), []);
	});

	// Security-relevant: a stale start-up answer must never overwrite a newer identity (it could report a
	// signed-out or a different user as current).
	// Planted negative control: delete the `ticket < this._lastAppliedTicket` check in _pull and the stale
	// signed-out answer is applied after the event: `applied` gains a trailing undefined and init resolves false.
	test('a change event outranks the start-up pull still in flight', async () => {
		const { result: pending } = await startInitialize(createProvider());

		host.fire({ epoch: 5, signedIn: true, user: { id: 'u5', email: 'e@example.com' } });
		host.pulls[0].resolve({ epoch: 4, signedIn: false });

		assert.strictEqual(await pending, true);
		assert.deepStrictEqual(client.applied, [{ id: 'u5', email: 'e@example.com' }]);
	});

	// Security-relevant: an absent host API must fail visibly, never read as "signed out".
	// Planted negative control: make _pull `return;` instead of throwing when `this._host === undefined` and
	// assert.rejects fails (initializeFromHost then throws a different error, or resolves).
	test('an absent vscode.quantlabHost fails the start-up read with the visible error', async () => {
		clearHost();
		const target = createProvider();

		await assert.rejects(target.initializeFromHost(), (error: Error) => error.message === HOST_IDENTITY_UNAVAILABLE);
		assert.deepStrictEqual(client.applied, [], 'nothing is applied: an unavailable host is not "signed out"');
	});

	// Security-relevant: a change event carrying more than the contract (a smuggled token among it) is refused.
	// Planted negative control: apply `raw` without parseHostIdentity in _onHostIdentityChanged and `applied`
	// gains the forged user.
	test('a malformed change event is shown and logged, and the held state is kept', async () => {
		const { result: pending } = await startInitialize(createProvider());
		host.pulls[0].resolve({ epoch: 1, signedIn: true, user: { id: 'u1', email: 'a@example.com' } });
		await pending;

		const secret = 'SENTINEL-NOT-A-REAL-TOKEN';
		host.fire({ epoch: 2, signedIn: true, user: { id: 'u9', email: 'x@example.com', accessToken: secret } });
		host.fire({ epoch: 0, signedIn: false });

		assert.deepStrictEqual(client.applied, [{ id: 'u1', email: 'a@example.com' }]);
		const errors = _errorMessagesSnapshot();
		assert.strictEqual(errors.length, 2);
		assert.ok(errors.every(message => message.startsWith('Could not apply the sign-in change from the host')));
		assert.ok(!errors.join('\n').includes(secret), 'the shown error must not echo a smuggled value');
	});

	test('dispose ends the onDidChangeIdentity subscription', async () => {
		const target = createProvider();

		target.dispose();
		provider = undefined;
		host.fire({ epoch: 2, signedIn: true, user: { id: 'u2', email: 'b@example.com' } });
		assert.deepStrictEqual(client.applied, []);
	});
});
