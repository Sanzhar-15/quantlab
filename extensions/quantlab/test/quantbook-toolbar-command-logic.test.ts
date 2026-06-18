/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Demo-prep toolbar (2026-06-10) -- unit tests for the vscode-free toolbar-command parser:
// parseToolbarCommandMessage validates the UNTRUSTED `{type:'toolbarCommand', command, preset?}`
// webview message against explicit whitelists; the panel (cellGridPanel.ts handleToolbarCommand) is a
// thin vscode shell over it. SECURITY-CRITICAL: nothing off-whitelist may map to a commandId (the
// panel only ever passes a parser-returned commandId to executeCommand), so the rejection tests below
// pin the whole attack surface. Mirrors quantbook-context-menu-logic.test.ts (no engine, no vscode).

import * as assert from 'assert';

import {
	parseToolbarCommandMessage,
	type ParsedToolbarCommand,
	type ToolbarFormatPreset,
} from '../src/quantbook/cellGrid/cellGridLogic';

/** Build a raw toolbar message the way the webview posts it. */
function msg(command: unknown, preset?: unknown): unknown {
	return preset === undefined ? { type: 'toolbarCommand', command } : { type: 'toolbarCommand', command, preset };
}

suite('toolbar-command parser -- simple (argument-less) commands', () => {
	const expected: Array<[string, string]> = [
		['freezePanes', 'quantlab.quantbookFreezePanes'],
		['unfreezePanes', 'quantlab.quantbookUnfreezePanes'],
		['saveAs', 'quantlab.quantbookSaveAs'],
		['openWorkbook', 'quantlab.quantbookOpen'],
		// Menu breadth (2026-06-10): the webview Data menu's sidebar reveals. The targets are the
		// `<viewId>.focus` commands VS Code auto-registers for the contributed wave-3 views (there is
		// no quantlab.quantbook* command for either sidebar) -- see TOOLBAR_SIMPLE_COMMAND_IDS.
		['showDepGraph', 'quantlab.depGraphView.focus'],
		['showLivePython', 'quantlab.livePythonView.focus'],
	];

	test('each simple command maps to its exact host command id', () => {
		for (const [command, commandId] of expected) {
			assert.deepStrictEqual(parseToolbarCommandMessage(msg(command)), {
				kind: 'simple', command, commandId,
			} as ParsedToolbarCommand);
		}
	});

	test('an extraneous preset on a simple command is tolerated (ignored, not rejected)', () => {
		// The security boundary is the whitelisted command/preset VALUES; stray fields are ignored like
		// the other webview envelopes' extras (e.g. webviewId).
		assert.deepStrictEqual(parseToolbarCommandMessage(msg('saveAs', 'Percent')), {
			kind: 'simple', command: 'saveAs', commandId: 'quantlab.quantbookSaveAs',
		} as ParsedToolbarCommand);
	});
});

suite('toolbar-command parser -- structural commands', () => {
	const expected: Array<[string, string]> = [
		['insertRowAbove', 'quantlab.quantbookInsertRowAbove'],
		['insertRowBelow', 'quantlab.quantbookInsertRowBelow'],
		['insertColumnLeft', 'quantlab.quantbookInsertColumnLeft'],
		['insertColumnRight', 'quantlab.quantbookInsertColumnRight'],
		['deleteRow', 'quantlab.quantbookDeleteRow'],
		['deleteColumn', 'quantlab.quantbookDeleteColumn'],
	];

	test('each of the six structural commands maps to its exact W3 host command id', () => {
		for (const [command, commandId] of expected) {
			assert.deepStrictEqual(parseToolbarCommandMessage(msg(command)), {
				kind: 'structural', command, commandId,
			} as ParsedToolbarCommand);
		}
	});
});

suite('toolbar-command parser -- setNumberFormat preset validation', () => {
	const validPresets: ToolbarFormatPreset[] = ['General', 'Number', 'NumberThousands', 'Currency', 'Percent', 'Date'];

	test('each whitelisted preset parses to a setNumberFormat result', () => {
		for (const preset of validPresets) {
			assert.deepStrictEqual(parseToolbarCommandMessage(msg('setNumberFormat', preset)), {
				kind: 'setNumberFormat', preset,
			} as ParsedToolbarCommand);
		}
	});

	test('Custom is rejected (it needs an input box -- the QuickPick command path owns it)', () => {
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 'Custom')), undefined);
	});

	test('a missing / non-string / unknown / case-mismatched preset is rejected', () => {
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 42)), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', null)), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 'Bogus')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 'percent')), undefined); // exact-case only
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', '0.00%')), undefined); // raw format strings are not presets
	});

	test('prototype-chain preset names never resolve (own-property whitelist only)', () => {
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 'toString')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 'constructor')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('setNumberFormat', 'hasOwnProperty')), undefined);
	});
});

// **Wave C (2026-06-18)** -- the parameterized decimal-nudge command. Mirrors setNumberFormat's
// preset validation: a closed `direction` whitelist maps to the engine's signed delta; an off-whitelist
// direction is rejected (No-Fallbacks -- the host never guesses, never trusts a wire int).
suite('toolbar-command parser -- nudgeDecimals (decimal pair)', () => {
	/** Build a nudgeDecimals message the way the webview posts it. */
	function nudge(direction?: unknown): unknown {
		return direction === undefined
			? { type: 'toolbarCommand', command: 'nudgeDecimals' }
			: { type: 'toolbarCommand', command: 'nudgeDecimals', direction };
	}

	test('increase -> delta +1, decrease -> delta -1', () => {
		assert.deepStrictEqual(parseToolbarCommandMessage(nudge('increase')), {
			kind: 'nudgeDecimals', direction: 'increase', delta: 1,
		});
		assert.deepStrictEqual(parseToolbarCommandMessage(nudge('decrease')), {
			kind: 'nudgeDecimals', direction: 'decrease', delta: -1,
		});
	});

	test('a missing / non-string / unknown / case-mismatched direction is rejected', () => {
		assert.strictEqual(parseToolbarCommandMessage(nudge()), undefined);
		assert.strictEqual(parseToolbarCommandMessage(nudge(1)), undefined);
		assert.strictEqual(parseToolbarCommandMessage(nudge(null)), undefined);
		assert.strictEqual(parseToolbarCommandMessage(nudge('Increase')), undefined); // exact-case only
		assert.strictEqual(parseToolbarCommandMessage(nudge('up')), undefined);
		// a wrong VALUE in the `direction` field is rejected (not a whitelisted direction)
		assert.strictEqual(parseToolbarCommandMessage(nudge('Currency')), undefined);
		// a preset in the (wrong) `preset` field with no `direction` is also rejected
		assert.strictEqual(parseToolbarCommandMessage(msg('nudgeDecimals', 'Currency')), undefined);
	});

	test('prototype-chain direction names never resolve (own-property whitelist only)', () => {
		assert.strictEqual(parseToolbarCommandMessage(nudge('toString')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(nudge('constructor')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(nudge('hasOwnProperty')), undefined);
	});
});

suite('toolbar-command parser -- off-whitelist rejection (the security boundary)', () => {
	test('rejects a non-object / null / primitive message', () => {
		assert.strictEqual(parseToolbarCommandMessage(undefined), undefined);
		assert.strictEqual(parseToolbarCommandMessage(null), undefined);
		assert.strictEqual(parseToolbarCommandMessage('toolbarCommand'), undefined);
		assert.strictEqual(parseToolbarCommandMessage(42), undefined);
	});

	test('rejects a wrong / missing type tag', () => {
		assert.strictEqual(parseToolbarCommandMessage({ command: 'saveAs' }), undefined);
		assert.strictEqual(parseToolbarCommandMessage({ type: 'sheetCommand', command: 'saveAs' }), undefined);
	});

	test('rejects a missing / non-string command', () => {
		assert.strictEqual(parseToolbarCommandMessage({ type: 'toolbarCommand' }), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg(7)), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg(null)), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg(['saveAs'])), undefined);
	});

	test('rejects unknown / near-miss command strings (never a guessed command)', () => {
		assert.strictEqual(parseToolbarCommandMessage(msg('bogus')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('SaveAs')), undefined); // exact-case only
		assert.strictEqual(parseToolbarCommandMessage(msg('open')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('quantlab.quantbookSaveAs')), undefined); // raw ids are not commands
		assert.strictEqual(parseToolbarCommandMessage(msg('workbench.action.terminal.new')), undefined); // arbitrary-command injection
		// Menu breadth (2026-06-10): the view-reveal additions widen the whitelist by exactly two
		// member names -- their near-misses and raw `<viewId>.focus` ids must stay rejected.
		assert.strictEqual(parseToolbarCommandMessage(msg('showdepgraph')), undefined); // exact-case only
		assert.strictEqual(parseToolbarCommandMessage(msg('showLivepython')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('quantlab.depGraphView.focus')), undefined); // raw ids are not commands
		assert.strictEqual(parseToolbarCommandMessage(msg('quantlab.dataView.focus')), undefined); // arbitrary-view injection
	});

	test('prototype-chain command names never resolve to a commandId (own-property whitelist only)', () => {
		assert.strictEqual(parseToolbarCommandMessage(msg('toString')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('constructor')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('hasOwnProperty')), undefined);
		assert.strictEqual(parseToolbarCommandMessage(msg('__proto__')), undefined);
	});

	test('every parsed commandId stays inside an exact pinned allowlist', () => {
		// Belt-and-braces over the per-command maps above: the panel passes parser-returned ids straight
		// to executeCommand, so pin EVERY id the parser may ever emit. Menu breadth (2026-06-10) widened
		// the old quantlab.quantbook*-prefix invariant: the two Data-menu sidebar reveals target the
		// auto-registered `<viewId>.focus` commands of the contributed wave-3 views (still quantlab.-
		// namespaced, but not quantbook-prefixed) -- so the invariant is now an EXACT id set, which is
		// strictly tighter than the prefix check it replaces (a rogue quantlab.quantbook* id would have
		// passed the old assertion; it fails this one).
		const allowedIds = new Set([
			'quantlab.quantbookFreezePanes', 'quantlab.quantbookUnfreezePanes',
			'quantlab.quantbookSaveAs', 'quantlab.quantbookOpen',
			'quantlab.depGraphView.focus', 'quantlab.livePythonView.focus',
			'quantlab.quantbookInsertRowAbove', 'quantlab.quantbookInsertRowBelow',
			'quantlab.quantbookInsertColumnLeft', 'quantlab.quantbookInsertColumnRight',
			'quantlab.quantbookDeleteRow', 'quantlab.quantbookDeleteColumn',
		]);
		const accepted = [
			'freezePanes', 'unfreezePanes', 'saveAs', 'openWorkbook', 'showDepGraph', 'showLivePython',
			'insertRowAbove', 'insertRowBelow', 'insertColumnLeft', 'insertColumnRight', 'deleteRow', 'deleteColumn',
		];
		for (const command of accepted) {
			const parsed = parseToolbarCommandMessage(msg(command));
			assert.notStrictEqual(parsed, undefined);
			assert.notStrictEqual(parsed!.kind, 'setNumberFormat');
			const commandId = (parsed as { commandId: string }).commandId;
			assert.ok(allowedIds.has(commandId), `${command} -> ${commandId}`);
		}
	});
});
