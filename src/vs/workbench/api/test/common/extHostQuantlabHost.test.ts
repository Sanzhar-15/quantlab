/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../base/test/common/utils.js';
import { ExtensionIdentifier, IExtensionDescription } from '../../../../platform/extensions/common/extensions.js';
import { NullLogService } from '../../../../platform/log/common/log.js';
import { ExtHostQuantlabHost, QuantlabHostStream, QuantlabHostStreamState } from '../../common/extHostQuantlabHost.js';
import { MainThreadQuantlabHostShape, QuantlabHostAnswerDto, QuantlabIdentityDto } from '../../common/extHost.protocol.js';
import { SingleProxyRPCProtocol } from './testRPCProtocol.js';

class RecordingMainThread implements MainThreadQuantlabHostShape {
	readonly subscribed: { handle: number; topic: string; epoch: number }[] = [];
	readonly unsubscribed: number[] = [];
	async $getIdentity(): Promise<QuantlabIdentityDto> { throw new Error('this suite pushes the identity first and never pulls it'); }
	async $signOut(): Promise<QuantlabHostAnswerDto> { throw new Error('this suite makes no sign-out call'); }
	async $request(): Promise<QuantlabHostAnswerDto> { throw new Error('this suite makes no request'); }
	async $subscribe(handle: number, topic: string, _params: unknown, epoch: number): Promise<QuantlabHostAnswerDto> {
		this.subscribed.push({ handle, topic, epoch });
		return { ok: true, data: null };
	}
	$unsubscribe(handle: number): void { this.unsubscribed.push(handle); }
	dispose(): void { /* nothing to release */ }
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const quantlabExtension = {
	identifier: new ExtensionIdentifier('quantlab.quantlab'),
	isBuiltin: true,
	isUnderDevelopment: false,
	extensionLocation: URI.file('/app/extensions/quantlab'),
} as unknown as IExtensionDescription;

suite('ExtHostQuantlabHost - subscription termination', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	let mainThread: RecordingMainThread;
	let host: ExtHostQuantlabHost;

	const signedOut = (epoch: number): QuantlabIdentityDto => ({ epoch, signedIn: false });

	setup(() => {
		mainThread = new RecordingMainThread();
		host = new ExtHostQuantlabHost(SingleProxyRPCProtocol(mainThread), new NullLogService(), URI.file('/app'));
	});

	/** Subscribes under epoch 1 and returns the stream, its main-thread handle and everything it delivered. */
	async function openSubscription(): Promise<{ stream: QuantlabHostStream; handle: number; data: unknown[]; states: QuantlabHostStreamState[] }> {
		host.$onDidChangeIdentity(signedOut(1));
		const api = host.createApi(quantlabExtension);
		assert.ok(api);
		const stream = api.subscribe('ticks', null);
		const data: unknown[] = [];
		const states: QuantlabHostStreamState[] = [];
		disposables.add(stream.onData(value => data.push(value)));
		disposables.add(stream.onState(state => states.push(state)));
		await flush();
		assert.strictEqual(mainThread.subscribed.length, 1);
		assert.strictEqual(mainThread.subscribed[0].epoch, 1);
		return { stream, handle: mainThread.subscribed[0].handle, data, states };
	}

	// A terminal state forgets the handle: a later delivery under the CURRENT epoch finds nobody, and a dispose owes nothing.
	for (const kind of ['closed', 'error'] as const) {

		// Planted negative control: restore the `state.kind === 'closed'` test (instead of the terminal pair) around the
		// `phase = 'ended'` / `delete(handle)` lines of $onState, or put the epoch test of `_deliverable` back in front of
		// them: the 'error' / old-epoch run keeps the handle, `data` receives the epoch-2 value and one unsubscribe is sent.
		test(`an old-epoch '${kind}' after the new identity still ends the subscriber and forgets the handle; dispose sends no unsubscribe`, async () => {
			const { stream, handle, data, states } = await openSubscription();

			host.$onDidChangeIdentity(signedOut(2));
			host.$onState(handle, { kind, message: 'review-ended' }, 1);

			assert.deepStrictEqual(states, [{ kind, message: 'review-ended' }]);
			host.$onData(handle, 'epoch-2 value', 2);
			assert.deepStrictEqual(data, [], 'the handle is gone: nothing is delivered to it any more');
			stream.dispose();
			assert.deepStrictEqual(mainThread.unsubscribed, []);
		});

		test(`a current-epoch '${kind}' ends the subscriber and forgets the handle; dispose sends no unsubscribe`, async () => {
			const { stream, handle, data, states } = await openSubscription();

			host.$onState(handle, { kind, message: 'review-ended' }, 1);
			host.$onData(handle, 'late value', 1);

			assert.deepStrictEqual(states, [{ kind, message: 'review-ended' }]);
			assert.deepStrictEqual(data, []);
			stream.dispose();
			assert.deepStrictEqual(mainThread.unsubscribed, []);
		});
	}

	test('old-epoch data and old-epoch non-terminal states stay undelivered', async () => {
		const { stream, handle, data, states } = await openSubscription();

		host.$onDidChangeIdentity(signedOut(2));
		host.$onData(handle, 'old user value', 1);
		host.$onState(handle, { kind: 'open' }, 1);
		host.$onState(handle, { kind: 'reconnecting' }, 1);

		assert.deepStrictEqual(data, []);
		assert.deepStrictEqual(states, []);
		// the subscription is still open: current-epoch data still reaches it
		host.$onData(handle, 'new user value', 2);
		assert.deepStrictEqual(data, ['new user value']);
		stream.dispose();
	});

	// Control for the "sends no unsubscribe" assertions above: a subscription that was not terminated owes exactly one.
	test('disposing a live subscription sends exactly one unsubscribe', async () => {
		const { stream, handle } = await openSubscription();

		stream.dispose();
		stream.dispose();

		assert.deepStrictEqual(mainThread.unsubscribed, [handle]);
	});
});
