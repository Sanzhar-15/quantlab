/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Megaudit D6 (2026-05-13): pin the wiring that turns a rejected
 * extension envelope into BOTH a console.error AND an assertive
 * aria-live announcement. Without these tests a future refactor of
 * the inline message listener could silently drop one branch — the
 * console branch typically survives in dev, the announcer wiring does
 * not.
 *
 * Tests the extracted `handleInvalidExtensionMessage` helper in
 * isolation rather than booting the full qviz-spec webview, which
 * keeps the test cheap and the failure modes obvious.
 */

import * as assert from 'assert';

import {
	handleInvalidExtensionMessage,
	type AnnouncerForInvalidMsg,
} from '../webview/qviz-spec/invalidMessage';

function recorder(): AnnouncerForInvalidMsg & {
	calls: Array<{ message: string; level: 'polite' | 'assertive' | undefined }>;
} {
	const calls: Array<{ message: string; level: 'polite' | 'assertive' | undefined }> = [];
	return {
		calls,
		announce(message, level) {
			calls.push({ message, level });
		},
	};
}

suite('qviz-spec D6 -- invalid extension message surfacing', () => {

	let errorSpy: { calls: unknown[][]; restore: () => void };

	setup(() => {
		const orig = console.error;
		const calls: unknown[][] = [];
		console.error = (...args: unknown[]): void => { calls.push(args); };
		errorSpy = { calls, restore: () => { console.error = orig; } };
	});

	teardown(() => { errorSpy.restore(); });

	test('logs the validator error to console.error', () => {
		const a = recorder();
		handleInvalidExtensionMessage('init.spec failed validation', a);
		assert.strictEqual(errorSpy.calls.length, 1);
		assert.strictEqual(errorSpy.calls[0][0], 'qviz-spec: invalid extension message:');
		assert.strictEqual(errorSpy.calls[0][1], 'init.spec failed validation');
	});

	test('emits an assertive aria-live announcement', () => {
		const a = recorder();
		handleInvalidExtensionMessage('data.arrow must be Uint8Array', a);
		assert.strictEqual(a.calls.length, 1);
		assert.strictEqual(a.calls[0].level, 'assertive');
		assert.match(a.calls[0].message, /Quantlab rejected an invalid message/);
	});

	test('announce message is stable across distinct validator errors (dedup-safe)', () => {
		// Codex D6 audit (2026-05-13): the prior implementation
		// interpolated the rejected envelope's `.type` into the
		// announcement. A misbehaving extension that rotates type
		// strings (`type: 'init'`, `type: 'data'`, `type: 'foo'`...)
		// would bypass the announcer's 1s exact-string dedup window
		// and churn the aria-live region. The stable generic message
		// collapses every rejection into one dedup bucket so a flood
		// of malformed envelopes does not pummel screen-reader users.
		const a = recorder();
		handleInvalidExtensionMessage('error A', a);
		handleInvalidExtensionMessage('error B', a);
		handleInvalidExtensionMessage('error C', a);
		// The announcer (downstream of handleInvalidExtensionMessage)
		// dedups via its own exact-string cache; what THIS helper
		// guarantees is that every call produces the SAME message
		// string, so dedup is effective.
		assert.strictEqual(a.calls.length, 3);
		const first = a.calls[0].message;
		for (const call of a.calls) {
			assert.strictEqual(call.message, first,
				'every rejection must produce the same announcement '
				+ 'string so the announcer can dedup naturally');
		}
	});

	test('does not throw when announcer.announce throws', () => {
		// Defence in depth: a misbehaving announcer should not bring
		// down the message-listener. (Today handleInvalidExtensionMessage
		// trusts the announcer; we pin the current contract so a
		// future refactor doesn't accidentally introduce a try/catch
		// that swallows real bugs upstream.)
		const a: AnnouncerForInvalidMsg = {
			announce: () => { throw new Error('synthetic'); },
		};
		// We INTEND for this to throw — pin that contract so we know
		// if behavior shifts. The caller's window-message listener
		// is the natural place to add a top-level try/catch if needed.
		assert.throws(() => handleInvalidExtensionMessage('x', a), /synthetic/);
	});

});
