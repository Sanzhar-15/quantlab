/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	QUANTLAB_EXT_DID_CHANGE_COMMAND,
	QUANTLAB_EXT_GET_COMMAND,
	QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_CHANNEL,
	QUANTLAB_HOST_IDENTITY_GET_REQUEST,
	QUANTLAB_LEGACY_LOGIN_SECRET_KEYS,
	parseIdentity,
} from '../../common/quantlabHostIdentity.js';

suite('QuantlabHostIdentity - parseIdentity', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('accepts the signed-out shape', () => {
		assert.deepStrictEqual(parseIdentity({ signedIn: false }), { signedIn: false });
	});

	test('accepts the signed-in shape with a name', () => {
		assert.deepStrictEqual(
			parseIdentity({ signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada' } }),
			{ signedIn: true, user: { id: 'u1', email: 'a@example.com', name: 'Ada' } }
		);
	});

	test('accepts the signed-in shape whose name is undefined or absent', () => {
		const expected = { signedIn: true, user: { id: 'u1', email: 'a@example.com', name: undefined } };
		assert.deepStrictEqual(parseIdentity({ signedIn: true, user: { id: 'u1', email: 'a@example.com', name: undefined } }), expected);
		assert.deepStrictEqual(parseIdentity({ signedIn: true, user: { id: 'u1', email: 'a@example.com' } }), expected);
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
		assert.throws(() => parseIdentity({ signedIn: true, user: { email: 'e' } }), /user\.id/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 1, email: 'e' } }), /user\.id/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u' } }), /user\.email/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', email: 5 } }), /user\.email/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', email: 'e', name: null } }), /user\.name/);
		assert.throws(() => parseIdentity({ signedIn: true, user: { id: 'u', email: 'e', name: 5 } }), /user\.name/);
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

suite('QuantlabHostIdentity - contract constants', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('channel and command names are the contract values', () => {
		assert.strictEqual(QUANTLAB_HOST_IDENTITY_GET_CHANNEL, 'vscode:quantlab-host-identity:get');
		assert.strictEqual(QUANTLAB_HOST_IDENTITY_CHANGED_CHANNEL, 'vscode:quantlab-host-identity:changed');
		assert.strictEqual(QUANTLAB_EXT_GET_COMMAND, '_quantlab.hostIdentity.get');
		assert.strictEqual(QUANTLAB_EXT_DID_CHANGE_COMMAND, '_quantlab.hostIdentity.didChange');
	});

	test('the get request is the envelope with a null input', () => {
		assert.deepStrictEqual(QUANTLAB_HOST_IDENTITY_GET_REQUEST, { v: 1, input: null });
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
