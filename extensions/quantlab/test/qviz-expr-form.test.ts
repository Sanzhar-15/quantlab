/// <reference lib="dom" />
/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * jsdom tests for `exprForm` -- Visualise v2 Step E.
 *
 * Covers: initial render reproduces the stored AST as text; typing a
 * valid expression dispatches an `expr` transform with the new AST +
 * references; typing an invalid expression marks the textarea and
 * surfaces an inline error WITHOUT dispatching; the column hint chips
 * insert text at the cursor.
 */

import { resetDom } from './helpers/jsdom-shim';

import * as assert from 'assert';

import {
	FORM_BY_KIND, defaultTransformOfKind, summarizeTransform,
	type TransformFormContext,
} from '../webview/qviz/components/transformForms';
import type { ExprTransform } from '../src/qviz/spec';

function ctx(columns: { name: string; dtype: string }[] = []): TransformFormContext {
	return {
		columns: columns.map(c => ({ ...c, nullable: false })),
		availableProducedNames: [],
	};
}

function mkRoot(): HTMLElement {
	const root = document.createElement('div');
	document.body.appendChild(root);
	return root;
}

function tick(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms));
}

const initial: ExprTransform = {
	kind: 'expr',
	as: 'mid',
	expression: {
		kind: 'binary', op: '/',
		left: {
			kind: 'binary', op: '+',
			left: { kind: 'col', name: 'high' },
			right: { kind: 'col', name: 'low' },
		},
		right: { kind: 'num', value: 2 },
	},
	references: ['high', 'low'],
};

suite('exprForm -- Visualise v2 jsdom coverage', () => {
	setup(() => { resetDom(); });

	test('mount renders textarea + as input pre-populated from AST', () => {
		const root = mkRoot();
		const factory = FORM_BY_KIND.expr;
		const handle = factory(initial, ctx([{ name: 'high', dtype: 'double' }, { name: 'low', dtype: 'double' }]), () => { /* */ });
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea');
		assert.ok(textarea, 'textarea must render');
		assert.ok(textarea!.value.includes('high'), `text must contain 'high', got: ${textarea!.value}`);
		assert.ok(textarea!.value.includes('low'));
		assert.ok(textarea!.value.includes('/'));

		const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]'));
		const asInp = inputs.find(i => i.value === 'mid');
		assert.ok(asInp, "an `as` input populated with 'mid' must exist");

		handle.dispose();
	});

	test('typing into the textarea does NOT dispatch (preserves cursor)', async () => {
		// Regression: dispatching on every keystroke caused the parent
		// renderCards() to rebuild the form, wiping cursor + in-flight
		// text. Dispatch is held until commit (change/blur or Ctrl+Enter).
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(initial, ctx(), (next: ExprTransform) => { updates.push(next); });
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = 'abs(close - open)';
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
		await tick(180);

		assert.strictEqual(updates.length, 0,
			`typing must NOT dispatch (got ${updates.length} dispatches)`);
		// The error UI MUST update on input though.
		assert.ok(!textarea.classList.contains('qviz-form-expr-textarea--invalid'),
			'valid input must clear the invalid class even without dispatch');

		handle.dispose();
	});

	test('change/blur commits a valid expression as a dispatch', () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(initial, ctx(), (next: ExprTransform) => { updates.push(next); });
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = 'abs(close - open)';
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));

		assert.strictEqual(updates.length, 1, `change should commit (got ${updates.length})`);
		const last = updates[0];
		assert.strictEqual(last.expression.kind, 'call');
		assert.deepStrictEqual([...last.references], ['close', 'open']);

		handle.dispose();
	});

	test('Ctrl+Enter commits without leaving the textarea', () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(initial, ctx(), (next: ExprTransform) => { updates.push(next); });
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = '(high + low) / 2';
		const W = window as unknown as { KeyboardEvent: typeof KeyboardEvent };
		textarea.dispatchEvent(new W.KeyboardEvent('keydown', {
			key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true,
		}));

		assert.strictEqual(updates.length, 1, 'Ctrl+Enter must dispatch');
		assert.strictEqual(updates[0].as, 'mid');

		handle.dispose();
	});

	test('typing an invalid expression marks the textarea inline (no dispatch)', async () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(initial, ctx(), (next: ExprTransform) => { updates.push(next); });
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = '(close + 1';  // unmatched paren
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));
		await tick(180);

		assert.strictEqual(updates.length, 0, 'parse error must not dispatch');
		assert.ok(textarea.classList.contains('qviz-form-expr-textarea--invalid'),
			'textarea should be marked invalid');
		const errBox = root.querySelector<HTMLDivElement>('.qviz-form-expr-error')!;
		assert.strictEqual(errBox.hidden, false, 'error box should be visible');
		assert.ok(errBox.textContent && errBox.textContent.length > 0,
			'error box must contain a message');

		// And: a commit on the invalid text must also NOT dispatch.
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));
		assert.strictEqual(updates.length, 0, 'change on invalid text must NOT dispatch');

		handle.dispose();
	});

	test('column hint chip inserts at the cursor and commits if valid', () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(
			initial,
			ctx([{ name: 'volume', dtype: 'double' }]),
			(next) => { updates.push(next); },
		);
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = '';
		textarea.selectionStart = textarea.selectionEnd = 0;

		const chip = Array.from(root.querySelectorAll<HTMLButtonElement>(
			'.qviz-form-expr-hint-chip',
		)).find(c => (c.firstChild?.textContent ?? '').trim() === 'volume'
			|| c.textContent?.startsWith('volume'));
		assert.ok(chip, 'volume hint chip must render');
		chip!.click();

		assert.ok(textarea.value.startsWith('volume'),
			`textarea should start with 'volume', got: ${textarea.value}`);
		assert.strictEqual(updates.length, 1,
			'chip insert is an explicit commit and should dispatch once');

		handle.dispose();
	});

	test('M2: as-field commits independently of in-flight invalid expression', () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(
			initial,
			ctx([{ name: 'h', dtype: 'double' }, { name: 'l', dtype: 'double' }]),
			(next) => { updates.push(next); },
		);
		root.appendChild(handle.root);

		// 1. User edits textarea to something unparseable (no dispatch).
		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = '(close + ';  // unmatched paren
		textarea.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('input', { bubbles: true }));

		// 2. User changes `as` and blurs it.
		const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]'));
		const asInp = inputs.find(i => i.value === 'mid')!;
		asInp.value = 'better_name';
		asInp.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));

		// The `as` edit MUST be committed (with the previous valid AST)
		// even though the textarea is mid-edit. Previous behavior
		// silently dropped the `as` change.
		assert.ok(updates.length >= 1,
			'as-field change MUST dispatch even when textarea is invalid');
		const last = updates[updates.length - 1];
		assert.strictEqual(last.as, 'better_name');
		// Expression should be the ORIGINAL valid AST (not the broken textarea text).
		assert.deepStrictEqual(last.expression, initial.expression);
	});

	test('M8: as-field collision against schema column shows inline error and blocks commit', () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(
			initial,
			ctx([{ name: 'high', dtype: 'double' }, { name: 'low', dtype: 'double' }]),
			(next) => { updates.push(next); },
		);
		root.appendChild(handle.root);

		const inputs = Array.from(root.querySelectorAll<HTMLInputElement>('input[type="text"]'));
		const asInp = inputs.find(i => i.value === 'mid')!;
		asInp.value = 'high';  // collide with existing column
		asInp.dispatchEvent(new (window as unknown as { Event: typeof Event }).Event('change', { bubbles: true }));

		assert.strictEqual(updates.length, 0,
			'collision must block commit (inline error instead of bad dispatch)');
		// Locate the as-error box and verify it shows the collision message.
		const allErrBoxes = Array.from(root.querySelectorAll<HTMLDivElement>('.qviz-form-expr-error'));
		assert.ok(allErrBoxes.some(b => !b.hidden && /already a column/.test(b.textContent ?? '')),
			`expected inline collision error, got: ${allErrBoxes.map(b => b.textContent).join(' | ')}`);
	});

	test('chip carries dtype hint in its label', () => {
		const root = mkRoot();
		const handle = FORM_BY_KIND.expr(
			initial,
			ctx([{ name: 'volume', dtype: 'double' }]),
			() => { /* */ },
		);
		root.appendChild(handle.root);

		const dtypeTag = root.querySelector<HTMLElement>('.qviz-form-expr-hint-chip-dtype');
		assert.ok(dtypeTag, 'every chip should expose a dtype tag for type-aware UX');
		assert.strictEqual(dtypeTag!.textContent, 'double');

		handle.dispose();
	});

	test('defaultTransformOfKind("expr") produces a parseable AST', () => {
		const def = defaultTransformOfKind('expr');
		assert.strictEqual(def.kind, 'expr');
		if (def.kind !== 'expr') { return; }
		assert.strictEqual(def.expression.kind, 'num');
		assert.ok(def.as.length > 0);
	});

	test('summarizeTransform renders an expr summary', () => {
		const s = summarizeTransform(initial);
		assert.ok(s.includes('mid'),
			`summary should mention the output column 'mid', got: ${s}`);
	});

	test('Codex LOW-3: chip-insert for non-bare names uses backtick form', () => {
		const root = mkRoot();
		const updates: ExprTransform[] = [];
		const handle = FORM_BY_KIND.expr(
			initial,
			ctx([{ name: 'mid price', dtype: 'double' }]),
			(next) => { updates.push(next); },
		);
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		textarea.value = '';
		textarea.selectionStart = textarea.selectionEnd = 0;

		const chip = Array.from(root.querySelectorAll<HTMLButtonElement>(
			'.qviz-form-expr-hint-chip',
		)).find(c => c.textContent?.startsWith('mid price'));
		assert.ok(chip, 'mid price chip must render');
		chip!.click();

		// Naive insertion would yield `mid price` which doesn't parse.
		// The fix wraps the name in backticks.
		assert.ok(textarea.value.includes('`mid price`'),
			`textarea must contain backtick-wrapped name, got: ${textarea.value}`);
		assert.strictEqual(updates.length, 1, 'chip insert must commit a dispatch');

		handle.dispose();
	});

	test('M7: handle.update() preserves textarea text + cursor across re-renders', () => {
		const root = mkRoot();
		const handle = FORM_BY_KIND.expr(
			initial,
			ctx([{ name: 'high', dtype: 'double' }]),
			() => { /* */ },
		);
		root.appendChild(handle.root);

		const textarea = root.querySelector<HTMLTextAreaElement>('textarea')!;
		// Simulate user typing an in-flight unparseable expression with cursor at end.
		textarea.value = '(close + ';
		textarea.selectionStart = textarea.selectionEnd = textarea.value.length;

		// Simulate a parent renderCards() pass: spec changed, update() called
		// with a fresh transform + ctx.
		assert.ok(typeof handle.update === 'function', 'expr form must expose update()');
		handle.update!(initial, ctx([
			{ name: 'high', dtype: 'double' },
			{ name: 'sma20', dtype: 'double' },  // new produced column upstream
		]));

		// Textarea text + cursor MUST be unchanged.
		assert.strictEqual(textarea.value, '(close + ',
			'in-flight text must survive update()');
		assert.strictEqual(textarea.selectionStart, '(close + '.length,
			'cursor position must survive update()');

		// And the new produced column SHOULD appear as a hint chip.
		const chips = Array.from(root.querySelectorAll<HTMLButtonElement>(
			'.qviz-form-expr-hint-chip',
		));
		assert.ok(chips.some(c => c.textContent?.includes('sma20')),
			'new upstream-produced column must appear as a chip after update()');

		handle.dispose();
	});

});
