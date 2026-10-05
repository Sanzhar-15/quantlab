/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../../base/common/cancellation.js';
import { Event } from '../../../../../../base/common/event.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../../base/test/common/utils.js';
import {
	IQuantlabHostIdentityService,
	QuantlabDataFrame,
	QuantlabHostError,
	QuantlabIdentity,
} from '../../../../../services/quantlabHostIdentity/common/quantlabHostIdentity.js';
import { DeltaPlusAdapter, QIC_HEALTH_OP, QIC_REQUEST_OP, QIC_STREAMING_UNAVAILABLE } from '../../../common/gateway/providers/deltaplusAdapter.js';
import type { ProviderRequest } from '../../../common/canonical/types.js';
import type { GatewayMetadata } from '../../../common/canonical/interfaces.js';

interface RecordedCall {
	readonly op: string;
	readonly input: unknown;
	readonly epoch: number;
	readonly cancelledAtCall: boolean;
}

type Answer = (op: string, input: unknown, token: CancellationToken) => Promise<unknown>;

const SIGNED_IN: QuantlabIdentity = { epoch: 7, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: undefined, tier: 'pro' } };
const SIGNED_OUT: QuantlabIdentity = { epoch: 8, signedIn: false };

/** A fake host: it records every data call and answers with the test's own function. */
class FakeHostIdentityService implements IQuantlabHostIdentityService {
	declare readonly _serviceBrand: undefined;
	readonly onDidChangeIdentity: Event<void> = Event.None;
	readonly onDidReceiveFrame: Event<QuantlabDataFrame> = Event.None;
	readonly calls: RecordedCall[] = [];

	constructor(private readonly identity: QuantlabIdentity, private readonly answer: Answer) { }

	async getIdentity(): Promise<QuantlabIdentity> {
		return this.identity;
	}

	request(op: string, input: unknown, epoch: number, token: CancellationToken): Promise<unknown> {
		this.calls.push({ op, input, epoch, cancelledAtCall: token.isCancellationRequested });
		return this.answer(op, input, token);
	}

	subscribe(): Promise<void> {
		throw new Error('DeltaPlusAdapter never subscribes');
	}

	unsubscribe(): void {
		throw new Error('DeltaPlusAdapter never unsubscribes');
	}

	signOut(): Promise<boolean> {
		throw new Error('DeltaPlusAdapter never signs out');
	}
}

function refuse(code: QuantlabHostError['code']): Answer {
	return () => Promise.reject(new QuantlabHostError(code, `refused: ${code}`, undefined));
}

/** Never answers on its own: once the token is cancelled it rejects `cancelled`, as the host does. */
const ANSWER_CANCELLED_ON_TOKEN: Answer = (_op, _input, token) => new Promise((_resolve, reject) => {
	if (token.isCancellationRequested) {
		reject(new QuantlabHostError('cancelled', 'cancelled before it was sent', undefined));
		return;
	}
	const listener = token.onCancellationRequested(() => {
		listener.dispose();
		reject(new QuantlabHostError('cancelled', 'cancelled', undefined));
	});
});

function chatRequest(signal?: AbortSignal): ProviderRequest & Partial<GatewayMetadata> {
	return { model: 'qic-default', messages: [{ role: 'user', content: 'hello' }], lane: 'chat-ask', signal };
}

async function assertRefusedWith(promise: Promise<unknown>, code: string): Promise<void> {
	await assert.rejects(promise, (err: unknown) => {
		assert.ok(err instanceof QuantlabHostError, `expected a QuantlabHostError, got ${String(err)}`);
		assert.strictEqual(err.code, code);
		return true;
	});
}

suite('DeltaPlusAdapter - host transport', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const originalFetch = globalThis.fetch;
	let fetchCalls = 0;

	setup(() => {
		fetchCalls = 0;
		globalThis.fetch = (() => {
			fetchCalls++;
			return Promise.reject(new Error('DeltaPlusAdapter must not call fetch'));
		}) as typeof fetch;
	});

	teardown(() => {
		globalThis.fetch = originalFetch;
		assert.strictEqual(fetchCalls, 0, 'DeltaPlusAdapter called fetch');
	});

	test('the constructor takes the host service only (no base URL, no request service)', () => {
		assert.strictEqual(DeltaPlusAdapter.length, 1);
	});

	test('health sends qic.health with a null input and the identity epoch', async () => {
		const host = new FakeHostIdentityService(SIGNED_IN, async () => ({ ok: true }));
		const adapter = new DeltaPlusAdapter(host);

		const health = await adapter.getHealth();

		assert.strictEqual(health.status, 'healthy');
		assert.deepStrictEqual(host.calls.map(c => [c.op, c.input, c.epoch]), [[QIC_HEALTH_OP, null, 7]]);
		assert.strictEqual(QIC_HEALTH_OP, 'qic.health');
	});

	test('a health refusal rejects with its code (no-route is not mapped to unavailable)', async () => {
		const host = new FakeHostIdentityService(SIGNED_IN, refuse('no-route'));
		const adapter = new DeltaPlusAdapter(host);

		await assertRefusedWith(adapter.getHealth(), 'no-route');
		await assertRefusedWith(adapter.isAvailable(), 'no-route');
	});

	test('sendRequest sends qic.request with the QIC body and the identity epoch, and parses the answer', async () => {
		const host = new FakeHostIdentityService(SIGNED_IN, async () => ({
			success: true,
			data: { content: 'hi there', usage: { input_tokens: 3, output_tokens: 2 }, stop_reason: 'end_turn' },
		}));
		const adapter = new DeltaPlusAdapter(host);

		const response = await adapter.sendRequest(chatRequest());

		assert.strictEqual(QIC_REQUEST_OP, 'qic.request');
		assert.strictEqual(host.calls.length, 1);
		assert.strictEqual(host.calls[0].op, QIC_REQUEST_OP);
		assert.strictEqual(host.calls[0].epoch, 7);
		assert.deepStrictEqual(host.calls[0].input, { lane: 'chat-ask', messages: [{ role: 'user', content: 'hello' }], stream: false });
		assert.deepStrictEqual(response, {
			content: [{ type: 'text', text: 'hi there' }],
			usage: { inputTokens: 3, outputTokens: 2, cacheReadTokens: undefined, cacheWriteTokens: undefined },
			stopReason: 'end_turn',
		});
	});

	test('a request refusal rejects with its code', async () => {
		for (const code of ['no-route', 'forbidden', 'identity-changed', 'server'] as const) {
			const host = new FakeHostIdentityService(SIGNED_IN, refuse(code));
			const adapter = new DeltaPlusAdapter(host);
			await assertRefusedWith(adapter.sendRequest(chatRequest()), code);
		}
	});

	test('signed out rejects not-signed-in and sends nothing', async () => {
		const host = new FakeHostIdentityService(SIGNED_OUT, async () => ({ ok: true }));
		const adapter = new DeltaPlusAdapter(host);

		await assertRefusedWith(adapter.sendRequest(chatRequest()), 'not-signed-in');
		await assertRefusedWith(adapter.getHealth(), 'not-signed-in');
		assert.strictEqual(host.calls.length, 0);
	});

	test('streaming rejects visibly and sends nothing', async () => {
		const host = new FakeHostIdentityService(SIGNED_IN, async () => ({ success: true, data: { content: 'never' } }));
		const adapter = new DeltaPlusAdapter(host);

		const stream = adapter.sendStreaming(chatRequest())[Symbol.asyncIterator]();
		await assert.rejects(stream.next(), (err: unknown) => err instanceof Error && err.message === QIC_STREAMING_UNAVAILABLE);
		assert.strictEqual(host.calls.length, 0);
	});

	test('an abort cancels the host request, which rejects cancelled', async () => {
		const host = new FakeHostIdentityService(SIGNED_IN, ANSWER_CANCELLED_ON_TOKEN);
		const adapter = new DeltaPlusAdapter(host);
		const controller = new AbortController();

		const pending = adapter.sendRequest(chatRequest(controller.signal));
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.strictEqual(host.calls.length, 1);
		controller.abort();

		await assertRefusedWith(pending, 'cancelled');
	});

	test('an already-aborted signal cancels before the call', async () => {
		const host = new FakeHostIdentityService(SIGNED_IN, ANSWER_CANCELLED_ON_TOKEN);
		const adapter = new DeltaPlusAdapter(host);
		const controller = new AbortController();
		controller.abort();

		await assertRefusedWith(adapter.sendRequest(chatRequest(controller.signal)), 'cancelled');
		assert.strictEqual(host.calls.length, 1);
		assert.strictEqual(host.calls[0].cancelledAtCall, true);
	});
});
