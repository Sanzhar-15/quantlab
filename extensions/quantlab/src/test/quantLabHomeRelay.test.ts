/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import * as assert from 'assert';
import { installVscodeShim, _commandsExecuted, _errorMessagesSnapshot, _resetShimState } from '../../test/helpers/vscode-shim';
installVscodeShim();
import { HOME_ALLOWED_COMMANDS, HOME_QUICK_ACTIONS, relayHomeMessage } from '../auth/QuantLabHome';

// The Home webview relay runs only the quick-action command ids; any other id is refused visibly
// (logged and shown), never executed.

async function relayCapturingConsole(msg: unknown): Promise<unknown[][]> {
	const logged: unknown[][] = [];
	const originalConsoleError = console.error;
	console.error = (...args: unknown[]): void => { logged.push(args); };
	try {
		await relayHomeMessage(msg);
	} finally {
		console.error = originalConsoleError;
	}
	return logged;
}

suite('QuantLabHome webview command relay (allow-list)', () => {
	setup(() => {
		_resetShimState();
	});

	test('the allow-list is exactly the quick-action command ids', () => {
		const fromActions = [...new Set(HOME_QUICK_ACTIONS.map(a => a.cmd))].sort();
		assert.deepStrictEqual([...HOME_ALLOWED_COMMANDS].sort(), fromActions);
	});

	test('an allowed id is executed with no error', async () => {
		for (const cmd of HOME_ALLOWED_COMMANDS) {
			_resetShimState();
			await relayCapturingConsole({ type: 'command', cmd });
			assert.deepStrictEqual(_commandsExecuted(), [{ command: cmd, args: [] }]);
			assert.deepStrictEqual(_errorMessagesSnapshot(), []);
		}
	});

	test('a non-allowed id is refused: not executed, logged, and shown naming the id', async () => {
		const refused = 'workbench.action.terminal.sendSequence';
		const logged = await relayCapturingConsole({ type: 'command', cmd: refused });
		assert.deepStrictEqual(_commandsExecuted(), [], 'a non-allowed id must never be executed');
		const errors = _errorMessagesSnapshot();
		assert.strictEqual(errors.length, 1, `expected exactly one visible error, got: ${JSON.stringify(errors)}`);
		assert.ok(errors[0].includes(refused), `the visible error must name the refused id, got: ${errors[0]}`);
		assert.strictEqual(logged.length, 1, 'the refusal must be logged once');
		assert.ok(String(logged[0][0]).includes(refused), 'the log line must name the refused id');
	});

	test('a command message without a string id is refused visibly', async () => {
		const logged = await relayCapturingConsole({ type: 'command' });
		assert.deepStrictEqual(_commandsExecuted(), []);
		assert.strictEqual(_errorMessagesSnapshot().length, 1);
		assert.strictEqual(logged.length, 1);
	});

	test('an unknown message type is refused visibly', async () => {
		const logged = await relayCapturingConsole({ type: 'runAnything', cmd: 'quantlab.focusDataPanel' });
		assert.deepStrictEqual(_commandsExecuted(), []);
		assert.strictEqual(_errorMessagesSnapshot().length, 1);
		assert.strictEqual(logged.length, 1);
	});
});
