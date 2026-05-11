/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit tests for SpecDocumentCore (audit-fix M14: lifecycle is testable
 * from plain mocha after extracting the vscode-free state machine from
 * QvizSpecDocument).
 *
 * Coverage:
 *   - applyEdit happy path + invalid + reentrancy + no-op + post-dispose
 *   - undo/redo round-trip + post-dispose silent no-op
 *   - captureForSave / markSaved updates dirty state
 *   - applyReload (revert) emits content + edit events with undo/redo
 *   - applyReload no-op when reloaded === current
 *   - dispose blocks subsequent ops, fires dispose handlers, clears handlers
 *   - frozen-snapshot accessors prevent external mutation
 */

import * as assert from 'assert';

import {
	type ContentChangeEvent, type EditEvent,
	DisposedError, ReentrantApplyEditError, SpecDocumentCore,
} from '../src/qviz/specDocCore';
import type { QvizSpec } from '../src/qviz/spec';

function validSpec(overrides: Partial<QvizSpec> = {}): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/x.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1,
		},
		transforms: [],
		chart: {
			family: 'general', type: 'scatter',
			encodings: {
				x: { field: 'a', type: 'quantitative' },
				y: { field: 'b', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: '2026-05-10T00:00:00Z',
			generator: 'test', query_hash: 'sha256:0',
			tool_versions: { qviz_schema: 1 },
		},
		...overrides,
	};
}

interface RecordedEvents {
	content: ContentChangeEvent[];
	edits: EditEvent[];
	disposes: number;
}

function attachRecorder(core: SpecDocumentCore): RecordedEvents {
	const r: RecordedEvents = { content: [], edits: [], disposes: 0 };
	core.onContentChange(e => r.content.push(e));
	core.onEdit(e => r.edits.push(e));
	core.onDispose(() => { r.disposes++; });
	return r;
}

// ---------------------------------------------------------------------------
// applyEdit
// ---------------------------------------------------------------------------

suite('SpecDocumentCore.applyEdit', () => {

	test('valid edit advances spec, fires content + edit events', () => {
		const core = new SpecDocumentCore(validSpec());
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'first' }), 'set title');
		assert.strictEqual(core.spec.title, 'first');
		assert.strictEqual(r.content.length, 1);
		assert.strictEqual(r.edits.length, 1);
		assert.strictEqual(r.content[0].label, 'set title');
		assert.strictEqual(r.content[0].previous.title, undefined);
		assert.strictEqual(r.content[0].next.title, 'first');
	});

	test('invalid edit throws and does NOT mutate state or fire events', () => {
		const core = new SpecDocumentCore(validSpec());
		const r = attachRecorder(core);
		const broken = { ...validSpec(), qviz_version: 99 } as unknown as QvizSpec;
		assert.throws(() => core.applyEdit(broken, 'broken'), /invalid spec/);
		assert.strictEqual(core.spec.title, undefined);
		assert.strictEqual(r.content.length, 0);
		assert.strictEqual(r.edits.length, 0);
	});

	test('audit-fix M5: no-op edit (structurally equal) is silently ignored', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'unchanged' }));
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'unchanged' }), 'no-op');
		assert.strictEqual(r.content.length, 0, 'no content change fired');
		assert.strictEqual(r.edits.length, 0, 'no edit recorded');
		assert.strictEqual(core.spec.title, 'unchanged');
	});

	test('audit-fix C5: reentrant applyEdit throws ReentrantApplyEditError', () => {
		// Megaudit CRITICAL-10 considered moving events outside the
		// guard so a subscriber's reentrant applyEdit could succeed —
		// but that produces a wrong-order undo stack (inner
		// registered before outer's fireEdit runs). Keep the original
		// guard; the production code path catches the rejection and
		// surfaces it as a structured error to the webview.
		const core = new SpecDocumentCore(validSpec({ title: 'outer-initial' }));
		let innerAttempted = false;
		let innerError: Error | null = null;
		core.onContentChange(() => {
			if (!innerAttempted) {
				innerAttempted = true;
				try {
					core.applyEdit(validSpec({ title: 'inner' }), 'inner');
				} catch (e) {
					innerError = e as Error;
				}
			}
		});
		core.applyEdit(validSpec({ title: 'after-outer' }), 'outer');
		assert.ok(innerAttempted, 'inner edit must have been attempted');
		const captured = innerError as Error | null;
		assert.ok(captured instanceof ReentrantApplyEditError,
			`expected ReentrantApplyEditError, got ${(captured as Error | null)?.constructor.name}`);
		// The OUTER edit succeeded; the inner did not.
		assert.strictEqual(core.spec.title, 'after-outer');
	});

	test('megaudit MAJOR-28: reentrant applyReload also throws ReentrantApplyEditError', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'initial' }));
		let innerError: Error | null = null;
		core.onContentChange(() => {
			if (innerError === null) {
				try {
					core.applyReload(validSpec({ title: 'inner-reload' }), 'inner');
				} catch (e) {
					innerError = e as Error;
				}
			}
		});
		core.applyReload(validSpec({ title: 'outer-reload' }), 'outer');
		const captured = innerError as Error | null;
		assert.ok(captured instanceof ReentrantApplyEditError,
			'applyReload must reject reentrant calls just like applyEdit');
	});

	test('megaudit CRITICAL-10 (final): a content-handler that throws WITHOUT being caught upstream still leaves a complete undo entry registered, AND the throw propagates', () => {
		// This was the audit's underlying concern: previously, if a
		// subscriber threw during fireContent, the outer applyEdit's
		// fireEdit was never called (the throw propagated past it),
		// leaving `_spec` mutated but no undo entry. Final fix wraps
		// fireContent in try/catch so fireEdit ALWAYS runs, then
		// re-throws after.
		// Megaudit-2 A5-MAJOR-6.4: previous assertion used
		// `/subscriber threw/.test(e.message)` which matched purely by
		// message text -- any unrelated error containing that substring
		// would satisfy the test. Use a sentinel error INSTANCE and
		// compare by identity (===) so the test pins down that THIS
		// specific error object was propagated, not some other error
		// that happens to share the message.
		const core = new SpecDocumentCore(validSpec({ title: 'initial' }));
		const recordedEdits: string[] = [];
		core.onEdit(e => { recordedEdits.push(e.label); });
		const sentinel = new Error('subscriber threw -- CRITICAL-10 sentinel identity');
		// Subscriber throws unconditionally.
		core.onContentChange(() => {
			throw sentinel;
		});
		// applyEdit must rethrow the EXACT sentinel instance...
		let caught: unknown = null;
		assert.throws(
			() => core.applyEdit(validSpec({ title: 'edited' }), 'outer-edit'),
			(e: Error) => { caught = e; return true; },
		);
		assert.strictEqual(caught, sentinel,
			'the propagated error must be the SAME instance the subscriber threw, '
			+ 'not a wrapped/rebuilt copy');
		// ...AND the undo entry MUST have been registered before the
		// throw propagated. Without the fix, recordedEdits would be
		// empty and the doc would be in an inconsistent state.
		assert.deepStrictEqual(recordedEdits, ['outer-edit'],
			'fireEdit must run even when a content subscriber throws');
		// The state mutation IS persisted (the spec did change).
		assert.strictEqual(core.spec.title, 'edited');
	});

	test('audit-fix M6: undo callback restores previous spec', async () => {
		const core = new SpecDocumentCore(validSpec({ title: 'initial' }));
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'edited' }), 'edit');
		assert.strictEqual(core.spec.title, 'edited');
		await r.edits[0].undo();
		assert.strictEqual(core.spec.title, 'initial');
		assert.strictEqual(r.content.length, 2,
			'undo fires a second content event');
		assert.ok(/undo edit/.test(r.content[1].label));
	});

	test('audit-fix M6: redo callback re-applies edit', async () => {
		const core = new SpecDocumentCore(validSpec({ title: 'initial' }));
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'edited' }), 'edit');
		await r.edits[0].undo();
		await r.edits[0].redo();
		assert.strictEqual(core.spec.title, 'edited');
		assert.strictEqual(r.content.length, 3);
		assert.ok(/redo edit/.test(r.content[2].label));
	});

	test('audit-fix M6: undo/redo are silent no-ops after dispose', async () => {
		const core = new SpecDocumentCore(validSpec({ title: 'initial' }));
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'edited' }), 'edit');
		core.dispose();
		// undo and redo should NOT throw (VS Code may invoke them on a
		// disposed document) and should NOT mutate state or fire events.
		await r.edits[0].undo();
		await r.edits[0].redo();
		// content events recorded only the original edit (handlers were
		// cleared on dispose, so post-dispose fires would be invisible).
		assert.strictEqual(r.content.length, 1);
	});

	test('post-dispose applyEdit throws DisposedError', () => {
		const core = new SpecDocumentCore(validSpec());
		core.dispose();
		assert.throws(
			() => core.applyEdit(validSpec({ title: 'too late' }), 'late'),
			DisposedError,
		);
	});

	test('multiple sequential edits build a linear undo stack', async () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'B' }), 'A->B');
		core.applyEdit(validSpec({ title: 'C' }), 'B->C');
		assert.strictEqual(r.edits.length, 2);
		await r.edits[1].undo();
		assert.strictEqual(core.spec.title, 'B');
		await r.edits[0].undo();
		assert.strictEqual(core.spec.title, 'A');
		await r.edits[0].redo();
		assert.strictEqual(core.spec.title, 'B');
		await r.edits[1].redo();
		assert.strictEqual(core.spec.title, 'C');
	});

});

// ---------------------------------------------------------------------------
// dirty state + save flow
// ---------------------------------------------------------------------------

suite('SpecDocumentCore dirty state + save flow', () => {

	test('isDirty flips to true on edit, back to false on markSaved', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		assert.strictEqual(core.isDirty, false);
		core.applyEdit(validSpec({ title: 'B' }), 'edit');
		assert.strictEqual(core.isDirty, true);
		const captured = core.captureForSave();
		core.markSaved(captured);
		assert.strictEqual(core.isDirty, false);
		assert.strictEqual(core.savedSpec.title, 'B');
	});

	test('captureForSave throws when disposed', () => {
		const core = new SpecDocumentCore(validSpec());
		core.dispose();
		assert.throws(() => core.captureForSave(), DisposedError);
	});

	test('markSaved on a disposed core is silently ignored (post-write race)', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		const captured = core.captureForSave();
		core.dispose();
		core.markSaved(captured);  // must not throw
	});

	test('serializeCurrent throws when disposed', () => {
		const core = new SpecDocumentCore(validSpec());
		core.dispose();
		assert.throws(() => core.serializeCurrent(), DisposedError);
	});

});

// ---------------------------------------------------------------------------
// applyReload (revert)
// ---------------------------------------------------------------------------

suite('SpecDocumentCore.applyReload (audit-fix C4)', () => {

	test('reload to a different spec fires content + edit events', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'in-memory' }));
		core.applyEdit(validSpec({ title: 'edited' }), 'edit');
		const r = attachRecorder(core);
		core.applyReload(validSpec({ title: 'on-disk' }), 'revert');
		assert.strictEqual(core.spec.title, 'on-disk');
		assert.strictEqual(core.savedSpec.title, 'on-disk');
		assert.strictEqual(core.isDirty, false);
		assert.strictEqual(r.content.length, 1);
		assert.strictEqual(r.edits.length, 1);
		assert.strictEqual(r.content[0].label, 'revert');
	});

	test('audit-fix C4: revert undo restores pre-revert spec', async () => {
		const core = new SpecDocumentCore(validSpec({ title: 'initial' }));
		core.applyEdit(validSpec({ title: 'edited' }), 'edit');
		const r = attachRecorder(core);
		core.applyReload(validSpec({ title: 'reverted' }), 'revert');
		// Cmd+Z after revert: must restore the pre-revert in-memory spec
		// (`edited`), NOT the original (`initial`).
		await r.edits[0].undo();
		assert.strictEqual(core.spec.title, 'edited');
	});

	test('reload that matches current spec is a no-op (only updates savedSpec)', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'same' }));
		// Use the core's CURRENT (post-validate, normalized) spec as the
		// reload target. Real-world callers pass parseSpecBytes output,
		// which is also post-validate; passing a hand-built spec object
		// would compare unequally against the normalized in-memory spec.
		core.applyEdit(validSpec({ title: 'edited' }), 'edit');
		const inMemory = core.spec;
		const r = attachRecorder(core);
		core.applyReload(inMemory, 'revert');
		assert.strictEqual(r.content.length, 0, 'no content event for no-op reload');
		assert.strictEqual(r.edits.length, 0, 'no edit event for no-op reload');
		// But savedSpec should now match (so isDirty returns false).
		assert.strictEqual(core.isDirty, false);
	});

});

// ---------------------------------------------------------------------------
// dispose
// ---------------------------------------------------------------------------

suite('SpecDocumentCore.dispose', () => {

	test('fires onDispose handlers exactly once', () => {
		const core = new SpecDocumentCore(validSpec());
		const r = attachRecorder(core);
		core.dispose();
		core.dispose();
		assert.strictEqual(r.disposes, 1);
	});

	test('clears event handlers so post-dispose fires are no-ops', async () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		const r = attachRecorder(core);
		core.applyEdit(validSpec({ title: 'B' }), 'edit');
		assert.strictEqual(r.content.length, 1);
		core.dispose();
		// undo() after dispose: short-circuits, doesn't fire content.
		await r.edits[0].undo();
		assert.strictEqual(r.content.length, 1, 'no new events post-dispose');
	});

	test('isDisposed flag flips immediately', () => {
		const core = new SpecDocumentCore(validSpec());
		assert.strictEqual(core.isDisposed, false);
		core.dispose();
		assert.strictEqual(core.isDisposed, true);
	});

	test('unsubscribe returned by onContentChange detaches handler', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		let count = 0;
		const off = core.onContentChange(() => { count++; });
		core.applyEdit(validSpec({ title: 'B' }), 'first');
		assert.strictEqual(count, 1);
		off();
		core.applyEdit(validSpec({ title: 'C' }), 'second');
		assert.strictEqual(count, 1, 'detached handler should not fire');
	});

});

// ---------------------------------------------------------------------------
// frozen snapshots (audit-fix M3)
// ---------------------------------------------------------------------------

suite('SpecDocumentCore frozen-snapshot accessors (audit-fix M3)', () => {

	test('spec returns a frozen object', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		const s = core.spec;
		assert.ok(Object.isFrozen(s));
		// Mutation either throws (strict mode) or silently fails
		// (sloppy mode); either way the value must NOT change.
		try { (s as { title?: string }).title = 'mutated'; } catch { /* strict mode */ }
		assert.strictEqual(s.title, 'A',
			'frozen object must not mutate even in sloppy mode');
	});

	test('mutating the returned spec does NOT corrupt the document state', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		const s = core.spec;
		try {
			(s as { title?: string }).title = 'mutated';
		} catch {
			// strict-mode throws; non-strict silently fails. Either way,
			// the core's spec is unchanged.
		}
		assert.strictEqual(core.spec.title, 'A',
			'core spec must be untouched by external mutation');
	});

	test('savedSpec returns a frozen object', () => {
		const core = new SpecDocumentCore(validSpec({ title: 'A' }));
		const s = core.savedSpec;
		assert.ok(Object.isFrozen(s));
	});

	test('nested objects in the snapshot are also frozen', () => {
		const core = new SpecDocumentCore(validSpec());
		const s = core.spec;
		assert.ok(Object.isFrozen(s.dataset));
		assert.ok(Object.isFrozen(s.chart));
		assert.ok(Object.isFrozen(s.provenance));
	});

});
