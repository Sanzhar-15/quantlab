/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-4 keyboard STATE MACHINE -- exhaustive table tests for the pure `gridKeyDispatch`. The webview wiring
// (preventDefault, the guards, the imperative execution) is operator smoke; this pins the key->action
// classification the refactor pivots on. Covers every mode x every handled key x the relevant modifiers,
// plus the No-Fallbacks passthrough contract for unhandled keys.

import * as assert from 'assert';

import {
	gridKeyDispatch,
	isEditLike,
	isNavLike,
	type GridAction,
	type GridMode,
	type KeyModifiers,
} from '../webview/sheets-webview/gridKeyDispatch';

/** Build a KeyModifiers from a sparse override (defaults = all false). */
function mods(over: Partial<KeyModifiers> = {}): KeyModifiers {
	return { meta: false, shift: false, alt: false, ...over };
}

function dispatch(mode: GridMode, key: string, over: Partial<KeyModifiers> = {}): GridAction {
	return gridKeyDispatch(mode, key, mods(over));
}

suite('FE-4 gridKeyDispatch -- mode predicates', () => {
	test('isNavLike / isEditLike partition the four modes', () => {
		assert.strictEqual(isNavLike('nav'), true);
		assert.strictEqual(isNavLike('range'), true);
		assert.strictEqual(isNavLike('edit'), false);
		assert.strictEqual(isNavLike('formula'), false);
		assert.strictEqual(isEditLike('edit'), true);
		assert.strictEqual(isEditLike('formula'), true);
		assert.strictEqual(isEditLike('nav'), false);
		assert.strictEqual(isEditLike('range'), false);
	});
});

suite('FE-4 gridKeyDispatch -- nav/range plain navigation', () => {
	const navModes: GridMode[] = ['nav', 'range'];
	for (const mode of navModes) {
		test(`[${mode}] plain arrows MOVE (extend=false)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'ArrowUp'), { kind: 'nav', dr: -1, dc: 0, extend: false });
			assert.deepStrictEqual(dispatch(mode, 'ArrowDown'), { kind: 'nav', dr: 1, dc: 0, extend: false });
			assert.deepStrictEqual(dispatch(mode, 'ArrowLeft'), { kind: 'nav', dr: 0, dc: -1, extend: false });
			assert.deepStrictEqual(dispatch(mode, 'ArrowRight'), { kind: 'nav', dr: 0, dc: 1, extend: false });
		});
		test(`[${mode}] Shift+arrows EXTEND (extend=true)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'ArrowUp', { shift: true }), { kind: 'nav', dr: -1, dc: 0, extend: true });
			assert.deepStrictEqual(dispatch(mode, 'ArrowDown', { shift: true }), { kind: 'nav', dr: 1, dc: 0, extend: true });
			assert.deepStrictEqual(dispatch(mode, 'ArrowLeft', { shift: true }), { kind: 'nav', dr: 0, dc: -1, extend: true });
			assert.deepStrictEqual(dispatch(mode, 'ArrowRight', { shift: true }), { kind: 'nav', dr: 0, dc: 1, extend: true });
		});
		test(`[${mode}] Enter moves DOWN and never extends (even with Shift)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Enter'), { kind: 'nav', dr: 1, dc: 0, extend: false });
			assert.deepStrictEqual(dispatch(mode, 'Enter', { shift: true }), { kind: 'nav', dr: 1, dc: 0, extend: false });
		});
		test(`[${mode}] Tab moves RIGHT, Shift+Tab LEFT, never extends`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Tab'), { kind: 'nav', dr: 0, dc: 1, extend: false });
			assert.deepStrictEqual(dispatch(mode, 'Tab', { shift: true }), { kind: 'nav', dr: 0, dc: -1, extend: false });
		});
		test(`[${mode}] plain Home -> rowStart; End -> usedEnd`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Home'), { kind: 'jump', target: 'rowStart' });
			assert.deepStrictEqual(dispatch(mode, 'End'), { kind: 'jump', target: 'usedEnd' });
		});
		test(`[${mode}] PageUp/PageDown -> pageMove`, () => {
			assert.deepStrictEqual(dispatch(mode, 'PageUp'), { kind: 'pageMove', dir: -1 });
			assert.deepStrictEqual(dispatch(mode, 'PageDown'), { kind: 'pageMove', dir: 1 });
		});
		test(`[${mode}] Escape -> collapse`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Escape'), { kind: 'collapse' });
		});
		test(`[${mode}] F2 -> beginEdit (no char)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'F2'), { kind: 'beginEdit' });
		});
		test(`[${mode}] Delete/Backspace -> clear`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Delete'), { kind: 'clear' });
			assert.deepStrictEqual(dispatch(mode, 'Backspace'), { kind: 'clear' });
		});
		test(`[${mode}] a printable char -> beginEdit with that char`, () => {
			assert.deepStrictEqual(dispatch(mode, 'a'), { kind: 'beginEdit', char: 'a' });
			assert.deepStrictEqual(dispatch(mode, '5'), { kind: 'beginEdit', char: '5' });
			assert.deepStrictEqual(dispatch(mode, '='), { kind: 'beginEdit', char: '=' });
			assert.deepStrictEqual(dispatch(mode, ' '), { kind: 'beginEdit', char: ' ' });
		});
		test(`[${mode}] a non-printable / unhandled key -> passthrough (No-Fallbacks)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Shift'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Control'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'F1'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'F5'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'CapsLock'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Insert'), { kind: 'passthrough' });
		});
		test(`[${mode}] F4 in a nav-like mode -> passthrough (F4 only acts in the editor)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'F4'), { kind: 'passthrough' });
		});
		test(`[${mode}] ALT + any key -> passthrough (the shipped alt early-return)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'ArrowDown', { alt: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'a', { alt: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Enter', { alt: true }), { kind: 'passthrough' });
		});
	}
});

suite('FE-4 gridKeyDispatch -- nav/range meta (Ctrl/Cmd) shortcuts', () => {
	const navModes: GridMode[] = ['nav', 'range'];
	for (const mode of navModes) {
		test(`[${mode}] Ctrl+Z -> undo; Ctrl+Shift+Z / Ctrl+Y -> redo`, () => {
			assert.deepStrictEqual(dispatch(mode, 'z', { meta: true }), { kind: 'undo' });
			assert.deepStrictEqual(dispatch(mode, 'Z', { meta: true }), { kind: 'undo' }); // case-insensitive
			assert.deepStrictEqual(dispatch(mode, 'z', { meta: true, shift: true }), { kind: 'redo' });
			assert.deepStrictEqual(dispatch(mode, 'y', { meta: true }), { kind: 'redo' });
			assert.deepStrictEqual(dispatch(mode, 'Y', { meta: true }), { kind: 'redo' });
		});
		test(`[${mode}] Ctrl+C/X/V -> copy/cut/paste (case-insensitive)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'c', { meta: true }), { kind: 'copy' });
			assert.deepStrictEqual(dispatch(mode, 'C', { meta: true }), { kind: 'copy' });
			assert.deepStrictEqual(dispatch(mode, 'x', { meta: true }), { kind: 'cut' });
			assert.deepStrictEqual(dispatch(mode, 'v', { meta: true }), { kind: 'paste' });
		});
		test(`[${mode}] Ctrl+F -> find`, () => {
			assert.deepStrictEqual(dispatch(mode, 'f', { meta: true }), { kind: 'find' });
			assert.deepStrictEqual(dispatch(mode, 'F', { meta: true }), { kind: 'find' });
		});
		test(`[${mode}] Ctrl+D -> fillDown; Ctrl+R -> fillRight (FE-4)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'd', { meta: true }), { kind: 'fillDown' });
			assert.deepStrictEqual(dispatch(mode, 'D', { meta: true }), { kind: 'fillDown' });
			assert.deepStrictEqual(dispatch(mode, 'r', { meta: true }), { kind: 'fillRight' });
			assert.deepStrictEqual(dispatch(mode, 'R', { meta: true }), { kind: 'fillRight' });
		});
		test(`[${mode}] Ctrl+Home -> jump a1; Ctrl+End -> jump usedEnd`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Home', { meta: true }), { kind: 'jump', target: 'a1' });
			assert.deepStrictEqual(dispatch(mode, 'End', { meta: true }), { kind: 'jump', target: 'usedEnd' });
		});
		test(`[${mode}] an unbound meta combo -> passthrough (No-Fallbacks; "leave other meta combos alone")`, () => {
			assert.deepStrictEqual(dispatch(mode, 'a', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'b', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 's', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'ArrowDown', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Enter', { meta: true }), { kind: 'passthrough' });
		});
		test(`[${mode}] meta beats alt: meta+key is classified even if alt is also down`, () => {
			// The shipped handler checks isMeta BEFORE altKey, so a meta combo wins.
			assert.deepStrictEqual(dispatch(mode, 'c', { meta: true, alt: true }), { kind: 'copy' });
		});
	}
});

suite('FE-4 gridKeyDispatch -- edit/formula mode', () => {
	const editModes: GridMode[] = ['edit', 'formula'];
	for (const mode of editModes) {
		test(`[${mode}] Escape -> editEscape`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Escape'), { kind: 'editEscape' });
		});
		test(`[${mode}] Enter -> commitMove down; Tab -> commitMove right; Shift+Tab -> left`, () => {
			assert.deepStrictEqual(dispatch(mode, 'Enter'), { kind: 'commitMove', dr: 1, dc: 0 });
			assert.deepStrictEqual(dispatch(mode, 'Tab'), { kind: 'commitMove', dr: 0, dc: 1 });
			assert.deepStrictEqual(dispatch(mode, 'Tab', { shift: true }), { kind: 'commitMove', dr: 0, dc: -1 });
		});
		test(`[${mode}] arrows -> editArrow (carry the vector; the imperative layer routes caret vs known-bad)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'ArrowUp'), { kind: 'editArrow', dr: -1, dc: 0 });
			assert.deepStrictEqual(dispatch(mode, 'ArrowDown'), { kind: 'editArrow', dr: 1, dc: 0 });
			assert.deepStrictEqual(dispatch(mode, 'ArrowLeft'), { kind: 'editArrow', dr: 0, dc: -1 });
			assert.deepStrictEqual(dispatch(mode, 'ArrowRight'), { kind: 'editArrow', dr: 0, dc: 1 });
		});
		test(`[${mode}] a printable char / caret keys -> passthrough (the <input> edits natively)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'a'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, '1'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Home'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'End'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Backspace'), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'Delete'), { kind: 'passthrough' });
		});
		test(`[${mode}] a META/ALT chord -> passthrough (native text editing in the input)`, () => {
			assert.deepStrictEqual(dispatch(mode, 'a', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'c', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'z', { meta: true }), { kind: 'passthrough' });
			assert.deepStrictEqual(dispatch(mode, 'ArrowLeft', { alt: true }), { kind: 'passthrough' });
		});
	}
	test('[formula] F4 -> cycleRef', () => {
		assert.deepStrictEqual(dispatch('formula', 'F4'), { kind: 'cycleRef' });
	});
	test('[edit] F4 -> passthrough (no ref to cycle when the value is not a formula)', () => {
		assert.deepStrictEqual(dispatch('edit', 'F4'), { kind: 'passthrough' });
	});
	test('[formula] F4 with a modifier -> passthrough (only a bare F4 cycles)', () => {
		assert.deepStrictEqual(dispatch('formula', 'F4', { meta: true }), { kind: 'passthrough' });
		assert.deepStrictEqual(dispatch('formula', 'F4', { alt: true }), { kind: 'passthrough' });
	});
});
