/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	QUANTLAB_HOST_DATA_CANCEL_CHANNEL,
	QUANTLAB_HOST_DATA_FRAME_CHANNEL,
	QUANTLAB_HOST_DATA_REQUEST_CHANNEL,
	QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL,
	QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL,
	QUANTLAB_HOST_ERROR_CODES,
	QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_REQUEST,
	QUANTLAB_LEGACY_LOGIN_SECRET_KEYS,
	QuantlabHostError,
	parseDataFrame,
	parseHostAnswer,
	parseIdentity,
	quantlabHostEnvelope,
} from '../../common/quantlabHostIdentity.js';

suite('QuantlabHostIdentity - parseIdentity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the signed-out shape', () => {
		assert.deepStrictEqual(parseIdentity({ epoch: 1, signedIn: false }), { epoch: 1, signedIn: false });
	});

	test('accepts the signed-in shape with a name', () => {
		assert.deepStrictEqual(
			parseIdentity({ epoch: 3, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada', tier: 'pro' } }),
			{ epoch: 3, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada', tier: 'pro' } }
		);
	});

	test('accepts the signed-in shape whose name is undefined or absent', () => {
		const expected = { epoch: 2, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: undefined, tier: 'pro' } };
		assert.deepStrictEqual(parseIdentity({ epoch: 2, signedIn: true, user: { id: 'u1', email: 'a@example.com', name: undefined, tier: 'pro' } }), expected);
		assert.deepStrictEqual(parseIdentity({ epoch: 2, signedIn: true, user: { id: 'u1', email: 'a@example.com', tier: 'pro' } }), expected);
	});

	// Security-relevant: a stale or forged epoch must not pass, or main's identity-changed check could be fed a value it never issued.
	// Planted negative control: make parseEpoch accept any number (drop `Number.isInteger(value) || value < 1`) and the 0, -1 and 1.5 cases stop throwing.
	test('rejects an identity whose epoch is missing or not an integer >= 1, in both shapes', () => {
		const user = { id: 'u', email: 'e', tier: 'pro' };
		for (const epoch of [undefined, null, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', [1]]) {
			assert.throws(() => parseIdentity({ epoch, signedIn: false }), /epoch is not an integer >= 1/, `signed out, epoch: ${String(epoch)}`);
			assert.throws(() => parseIdentity({ epoch, signedIn: true, user }), /epoch is not an integer >= 1/, `signed in, epoch: ${String(epoch)}`);
		}
		assert.throws(() => parseIdentity({ signedIn: false }), /epoch is not an integer >= 1/);
		assert.throws(() => parseIdentity({ signedIn: true, user }), /epoch is not an integer >= 1/);
	});

	test('rejects anything that is not an object', () => {
		for (const value of [undefined, null, 'x', 7, true, [], [{ signedIn: false }]]) {
			assert.throws(() => parseIdentity(value), /not an object/, `value: ${JSON.stringify(value)}`);
		}
	});

	test('rejects an answer without a boolean signedIn', () => {
		for (const value of [{}, { signedIn: 'false' }, { signedIn: 0 }, { signedIn: null }, { user: { id: 'u', email: 'e' } }]) {
			assert.throws(() => parseIdentity(value), /no boolean signedIn/, `value: ${JSON.stringify(value)}`);
		}
	});

	test('rejects a signed-out answer carrying any extra field', () => {
		assert.throws(() => parseIdentity({ signedIn: false, user: { id: 'u', email: 'e' } }), /unexpected field 'user'/);
		assert.throws(() => parseIdentity({ signedIn: false, error: 'x' }), /unexpected field 'error'/);
	});

	test('rejects a signed-in answer without a user object', () => {
		for (const value of [{ signedIn: true }, { signedIn: true, user: null }, { signedIn: true, user: 'u' }, { signedIn: true, user: [] }]) {
			assert.throws(() => parseIdentity(value), /no user object/, `value: ${JSON.stringify(value)}`);
		}
	});

	test('rejects a user with a missing or mistyped field', () => {
		assert.throws(() => parseIdentity({ signedIn: true, user: { email: 'e', tier: 'pro' } }), /user\.id/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 1, email: 'e', tier: 'pro' } }), /user\.id/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', tier: 'pro' } }), /user\.email/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', email: 5, tier: 'pro' } }), /user\.email/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', email: 'e', name: null, tier: 'pro' } }), /user\.name/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', email: 'e', name: 5, tier: 'pro' } }), /user\.name/);
	});

	// AUTH-TIER (PLAN-FINAL §3.2 item 1): Go's tier is required; an absent, empty or non-string tier throws, never a default.
	// Planted negative control: drop the user.tier check in parseIdentity and every case below parses.
	test('rejects a user whose tier is absent, empty or not a string', () => {
		assert.throws(() => parseIdentity({ epoch: 1, signedIn: true, user: { id: 'u', email: 'e' } }), /user\.tier/, 'tier absent');
		for (const tier of [undefined, '', null, 5]) {
			assert.throws(() => parseIdentity({ epoch: 1, signedIn: true, user: { id: 'u', email: 'e', tier } }), /user\.tier/, `tier: ${String(tier)}`);
		}
	});

	test('rejects a credential smuggled in as an extra field, and never echoes its value', () => {
		const secret = 'SENTINEL-NOT-A-REAL-TOKEN';
		const candidates: unknown[] = [
			{ signedIn: true, user: { id: 'u', email: 'e' }, accessToken: secret },
			{ signedIn: true, user: { id: 'u', email: 'e', accessToken: secret } },
			{ signedIn: false, token: secret },
		];
		for (const value of candidates) {
			assert.throws(() => parseIdentity(value), (error: Error) => {
				assert.ok(/unexpected field/.test(error.message));
				assert.ok(!error.message.includes(secret));
				return true;
			});
		}
	});
});

suite('QuantlabHostIdentity - parseHostAnswer', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ok:true answers its data, including null', () => {
		assert.deepStrictEqual(parseHostAnswer({ ok: true, data: { bars: [1, 2] } }, 'request'), { ok: true, data: { bars: [1, 2] } });
		assert.deepStrictEqual(parseHostAnswer({ ok: true, data: null }, 'subscribe'), { ok: true, data: null });
	});

	test('ok:false answers a QuantlabHostError with every contract code', () => {
		for (const code of QUANTLAB_HOST_ERROR_CODES) {
			const status = code === 'server' ? 502 : undefined;
			const answer = parseHostAnswer(status === undefined ? { ok: false, code, message: 'm' } : { ok: false, code, message: 'm', status }, 'request');
			assert.strictEqual(answer.ok, false);
			if (!answer.ok) {
				assert.ok(answer.error instanceof QuantlabHostError);
				assert.strictEqual(answer.error.code, code);
				assert.strictEqual(answer.error.message, 'm');
				assert.strictEqual(answer.error.status, status);
				assert.strictEqual(answer.error.name, 'QuantlabHostError');
			}
		}
	});

	test('rejects a malformed answer', () => {
		const cases: [unknown, RegExp][] = [
			[null, /not an object/],
			['ok', /not an object/],
			[{ ok: true }, /no data/],
			[{ ok: 'true', data: 1 }, /no boolean ok/],
			[{ data: 1 }, /no boolean ok/],
			[{ ok: false, message: 'm' }, /no known code/],
			[{ ok: false, code: 'teapot', message: 'm' }, /no known code/],
			[{ ok: false, code: 'forbidden' }, /no string message/],
			[{ ok: false, code: 'server', message: 'm' }, /code 'server' and no status/],
			[{ ok: false, code: 'server', message: 'm', status: '502' }, /status is neither an integer nor absent/],
			[{ ok: false, code: 'forbidden', message: 'm', status: 1.5 }, /status is neither an integer nor absent/],
		];
		for (const [value, expected] of cases) {
			assert.throws(() => parseHostAnswer(value, 'request'), expected, `value: ${JSON.stringify(value)}`);
		}
	});

	// Security-relevant: a credential smuggled into an answer must not reach the extension host.
	// Planted negative control: delete the assertOnlyKeys call for `ok: true` in parseHostAnswer and the first case parses.
	test('rejects an answer carrying an extra field, and never echoes its value', () => {
		const secret = 'SENTINEL-NOT-A-REAL-TOKEN';
		for (const value of [{ ok: true, data: 1, token: secret }, { ok: false, code: 'forbidden', message: 'm', accessToken: secret }]) {
			assert.throws(() => parseHostAnswer(value, 'request'), (error: Error) => {
				assert.ok(/unexpected field/.test(error.message));
				assert.ok(!error.message.includes(secret));
				return true;
			});
		}
	});
});

suite('QuantlabHostIdentity - parseDataFrame', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the data and the state shapes', () => {
		assert.deepStrictEqual(parseDataFrame({ handle: 0, epoch: 1, kind: 'data', data: { p: 1 } }), { handle: 0, epoch: 1, kind: 'data', data: { p: 1 } });
		assert.deepStrictEqual(parseDataFrame({ handle: 4, epoch: 2, kind: 'state', state: { kind: 'open' } }), { handle: 4, epoch: 2, kind: 'state', state: { kind: 'open' } });
		assert.deepStrictEqual(
			parseDataFrame({ handle: 4, epoch: 2, kind: 'state', state: { kind: 'closed', message: 'identity-changed' } }),
			{ handle: 4, epoch: 2, kind: 'state', state: { kind: 'closed', message: 'identity-changed' } }
		);
	});

	test('rejects a malformed frame', () => {
		const cases: [unknown, RegExp][] = [
			[null, /not an object/],
			[{ epoch: 1, kind: 'data', data: 1 }, /handle is not an integer/],
			[{ handle: -1, epoch: 1, kind: 'data', data: 1 }, /handle is not an integer/],
			[{ handle: 1.5, epoch: 1, kind: 'data', data: 1 }, /handle is not an integer/],
			[{ handle: 1, epoch: 0, kind: 'data', data: 1 }, /epoch is not an integer >= 1/],
			[{ handle: 1, kind: 'state', state: { kind: 'open' } }, /epoch is not an integer >= 1/],
			[{ handle: 1, epoch: 1, kind: 'data' }, /no data/],
			[{ handle: 1, epoch: 1, kind: 'other' }, /neither 'data' nor 'state'/],
			[{ handle: 1, epoch: 1, kind: 'state' }, /state is not an object/],
			[{ handle: 1, epoch: 1, kind: 'state', state: { kind: 'paused' } }, /no known kind/],
			[{ handle: 1, epoch: 1, kind: 'state', state: { kind: 'error', message: 5 } }, /message is neither a string nor absent/],
			[{ handle: 1, epoch: 1, kind: 'data', data: 1, state: { kind: 'open' } }, /unexpected field 'state'/],
			[{ handle: 1, epoch: 1, kind: 'state', state: { kind: 'open', token: 'x' } }, /unexpected field 'token'/],
		];
		for (const [value, expected] of cases) {
			assert.throws(() => parseDataFrame(value), expected, `value: ${JSON.stringify(value)}`);
		}
	});
});

suite('QuantlabHostIdentity - contract constants', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('channel names are the contract values', () => {
		assert.strictEqual(QUANTLAB_HOST_IDENTITY_GET_CHANNEL, 'vscode:quantlab-host-identity:get');
		assert.strictEqual(QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL, 'vscode:quantlab-host-identity:changed');
	});

	test('the get request is the envelope with a null input', () => {
		assert.deepStrictEqual(QUANTLAB_HOST_IDENTITY_GET_REQUEST, { v: 1, input: null });
	});

	test('the data channels are the IPC-DATA values, and the envelope is { v: 1, input }', () => {
		assert.strictEqual(QUANTLAB_HOST_DATA_REQUEST_CHANNEL, 'vscode:quantlab-host-data:request');
		assert.strictEqual(QUANTLAB_HOST_DATA_CANCEL_CHANNEL, 'vscode:quantlab-host-data:cancel');
		assert.strictEqual(QUANTLAB_HOST_DATA_SUBSCRIBE_CHANNEL, 'vscode:quantlab-host-data:subscribe');
		assert.strictEqual(QUANTLAB_HOST_DATA_UNSUBSCRIBE_CHANNEL, 'vscode:quantlab-host-data:unsubscribe');
		assert.strictEqual(QUANTLAB_HOST_DATA_FRAME_CHANNEL, 'vscode:quantlab-host-data:frame');
		assert.deepStrictEqual(quantlabHostEnvelope({ id: '1' }), { v: 1, input: { id: '1' } });
	});

	test('the error codes are the nine IPC-DATA codes, each once', () => {
		assert.deepStrictEqual([...QUANTLAB_HOST_ERROR_CODES].sort(), [
			'bad-request',
			'cancelled',
			'forbidden',
			'identity-changed',
			'no-route',
			'not-available',
			'not-signed-in',
			'server',
			'too-large',
		]);
	});

	test('the legacy login keys are the seven the older builds wrote, each once', () => {
		assert.deepStrictEqual([...QUANTLAB_LEGACY_LOGIN_SECRET_KEYS].sort(), [
			'deltaplus.sessions',
			'qic.cloudAccessToken',
			'qic.cloudRefreshToken',
			'qic.cloudTokenExpiresAt',
			'qic.deltaplusAccessToken',
			'qic.deltaplusRefreshToken',
			'qic.deltaplusTokenExpiresAt',
		]);
	});
});
