/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * SpecDocumentCore — vscode-free state machine for the .qviz.json document.
 *
 * QvizSpecDocument (the vscode-side `CustomDocument` adapter) wraps an
 * instance of this class. The split exists so the lifecycle of the
 * document (spec, savedSpec, dirty state, applyEdit reentrancy guard,
 * undo/redo callbacks, content-change events) is testable from plain
 * mocha without a vscode shim.
 *
 * Concerns OWNED by this core:
 *   - In-memory spec + saved-spec state.
 *   - Edit validation via `validateEdit`.
 *   - Reentrancy guard (audit-fix C5).
 *   - No-op edit short-circuit (audit-fix M5).
 *   - Undo/redo callbacks that respect disposal (audit-fix M6).
 *   - Frozen-snapshot accessors (audit-fix M3).
 *   - Subscription model for content-change / edit / dispose events.
 *
 * Concerns NOT in this core (the vscode adapter handles them):
 *   - Filesystem I/O (read/write/backup-delete).
 *   - vscode.EventEmitter / Disposable lifecycle.
 *   - Hot-exit backup-id round-trip.
 *
 * The pattern mirrors `qviz/render/timeseries.ts` (pure compiler) /
 * `applier.ts` (vscode-runtime apply): pure logic in one file,
 * runtime-binding adapter in another.
 */

import type { QvizSpec } from './spec';
import { serializeSpec, validateEdit } from './specCore';
import { structurallyEqual } from './structuralEqual';

export interface ContentChangeEvent {
	readonly previous: QvizSpec;
	readonly next: QvizSpec;
	readonly label: string;
}

export interface EditEvent {
	readonly label: string;
	readonly undo: () => Promise<void>;
	readonly redo: () => Promise<void>;
}

export type Unsubscribe = () => void;

export class ReentrantApplyEditError extends Error {
	constructor() {
		super('SpecDocumentCore.applyEdit is non-reentrant; nested edit rejected');
		this.name = 'ReentrantApplyEditError';
	}
}

export class DisposedError extends Error {
	constructor() {
		super('SpecDocumentCore has been disposed');
		this.name = 'DisposedError';
	}
}

export class SpecDocumentCore {
	private _spec: QvizSpec;
	private _savedSpec: QvizSpec;
	private _disposed = false;
	private _applyingEdit = false;

	private readonly contentHandlers: ((e: ContentChangeEvent) => void)[] = [];
	private readonly editHandlers: ((e: EditEvent) => void)[] = [];
	private readonly disposeHandlers: (() => void)[] = [];

	constructor(initial: QvizSpec) {
		this._spec = initial;
		this._savedSpec = initial;
	}

	// -----------------------------------------------------------------------
	// state accessors (audit-fix M3: frozen snapshots so external mutators
	// can't corrupt the in-memory state)
	// -----------------------------------------------------------------------

	get spec(): QvizSpec { return frozenClone(this._spec); }
	get savedSpec(): QvizSpec { return frozenClone(this._savedSpec); }
	get isDirty(): boolean { return this._spec !== this._savedSpec; }
	get isDisposed(): boolean { return this._disposed; }

	// -----------------------------------------------------------------------
	// event subscriptions
	// -----------------------------------------------------------------------

	onContentChange(handler: (e: ContentChangeEvent) => void): Unsubscribe {
		this.contentHandlers.push(handler);
		return () => removeOnce(this.contentHandlers, handler);
	}

	onEdit(handler: (e: EditEvent) => void): Unsubscribe {
		this.editHandlers.push(handler);
		return () => removeOnce(this.editHandlers, handler);
	}

	onDispose(handler: () => void): Unsubscribe {
		this.disposeHandlers.push(handler);
		return () => removeOnce(this.disposeHandlers, handler);
	}

	// -----------------------------------------------------------------------
	// lifecycle
	// -----------------------------------------------------------------------

	/**
	 * Apply an edit. Throws on:
	 *   - disposed core (DisposedError).
	 *   - reentrant call (ReentrantApplyEditError) -- audit-fix C5.
	 *   - invalid `next` spec (Error with validator-formatted message).
	 *
	 * Short-circuits silently when `next` is structurally equal to the
	 * current spec (audit-fix M5). Otherwise fires `onContentChange` and
	 * `onEdit` synchronously.
	 */
	applyEdit(next: QvizSpec, label: string): void {
		this.assertNotDisposed();
		if (this._applyingEdit) {
			throw new ReentrantApplyEditError();
		}
		const r = validateEdit(next);
		if (!r.ok) {
			throw new Error(`SpecDocumentCore.applyEdit rejected an invalid spec: ${r.error}`);
		}
		if (r.spec === this._spec || structurallyEqual(r.spec, this._spec)) {
			return;
		}
		const previous = this._spec;
		const accepted = r.spec;
		// Megaudit CRITICAL-10 (final): the audit raised a real concern
		// — a content-handler that throws WITHOUT being caught upstream
		// would short-circuit fireEdit, leaving `_spec` mutated but
		// the undo entry never registered (silently corrupting the
		// undo stack). Naively moving events outside the guard caused
		// undo-stack reordering (inner reentrant edit registered
		// before outer's fireEdit). Final design: keep the guard
		// (rejects reentrant calls), wrap fireContent in its own
		// try/catch so a thrown subscriber error doesn't skip
		// fireEdit, then re-throw the captured error AFTER fireEdit
		// has registered the undo entry. Net: state mutation, undo
		// entry, and error propagation all happen — no path leaves
		// the doc in an inconsistent state.
		this._applyingEdit = true;
		let contentError: unknown = undefined;
		let editError: unknown = undefined;
		try {
			this._spec = accepted;
			try {
				this.fireContent({ previous, next: accepted, label });
			} catch (e) {
				contentError = e;
			}
			// Megaudit-2 M2: wrap fireEdit in its own try/catch.
			// Without this, an onEdit subscriber throw escapes past the
			// `if (contentError !== undefined) throw contentError;` line,
			// MASKING the original content-handler error and leaving the
			// caller misdiagnosing the failure. Now both errors are
			// captured and re-thrown in priority order (content first,
			// since it's the more proximate cause of state corruption).
			try {
				this.fireEdit({
					label,
					// Audit-fix M6: undo/redo callbacks check disposal before
					// mutating; VS Code may invoke them after dispose.
					// Megaudit-2 A1-M5: hold the `_applyingEdit` guard
					// across the mutation+fireContent so a subscriber that
					// synchronously calls applyEdit/applyReload from
					// inside the content handler throws
					// ReentrantApplyEditError rather than silently
					// corrupting the undo stack (same invariant as
					// applyEdit itself).
					undo: async () => {
						if (this._disposed) { return; }
						if (this._applyingEdit) {
							throw new ReentrantApplyEditError();
						}
						this._applyingEdit = true;
						try {
							this._spec = previous;
							this.fireContent({ previous: accepted, next: previous, label: `undo ${label}` });
						} finally {
							this._applyingEdit = false;
						}
					},
					redo: async () => {
						if (this._disposed) { return; }
						if (this._applyingEdit) {
							throw new ReentrantApplyEditError();
						}
						this._applyingEdit = true;
						try {
							this._spec = accepted;
							this.fireContent({ previous, next: accepted, label: `redo ${label}` });
						} finally {
							this._applyingEdit = false;
						}
					},
				});
			} catch (e) {
				editError = e;
			}
		} finally {
			this._applyingEdit = false;
		}
		if (contentError !== undefined) {
			throw contentError;
		}
		if (editError !== undefined) {
			throw editError;
		}
	}

	/**
	 * Update `savedSpec` to reflect a successful save. Must be called by
	 * the adapter AFTER the disk write resolves. This is the single
	 * dirty-state advance point.
	 *
	 * Captures the spec to save BEFORE the I/O so concurrent edits don't
	 * cause `savedSpec` to drift past what's on disk.
	 */
	captureForSave(): QvizSpec {
		this.assertNotDisposed();
		return this._spec;
	}

	markSaved(saved: QvizSpec): void {
		if (this._disposed) { return; }
		this._savedSpec = saved;
	}

	/**
	 * Apply a reload from disk (revert). Fires content + edit events
	 * (audit-fix C4: revert is registered with VS Code's undo stack as a
	 * single edit so Cmd+Z restores the pre-revert in-memory spec).
	 *
	 * No-op if the reloaded spec is structurally equal to the current
	 * in-memory spec; only `_savedSpec` is updated in that case.
	 */
	applyReload(reloaded: QvizSpec, label = 'revert'): void {
		this.assertNotDisposed();
		// Megaudit MAJOR-28: applyReload was missing the `_applyingEdit`
		// reentrancy guard. A subscriber that synchronously called
		// applyReload from within a content handler would corrupt the
		// undo stack. Use the same guard as applyEdit.
		if (this._applyingEdit) {
			throw new ReentrantApplyEditError();
		}
		const previous = this._spec;
		if (structurallyEqual(reloaded, previous)) {
			// Set saved=current (same reference) so isDirty's ref-equality
			// check returns false. Using `reloaded` directly would leave
			// the references diverged even though the values match.
			this._savedSpec = this._spec;
			return;
		}
		// Mirror applyEdit's guarded semantics: hold the guard across
		// state mutation AND event firing so a subscriber's reentrant
		// applyEdit/applyReload throws ReentrantApplyEditError.
		// Megaudit CRITICAL-10 (final) applied here too: wrap
		// fireContent so a content-handler throw doesn't skip the
		// fireEdit (undo entry); re-throw afterward so callers see
		// the error.
		this._applyingEdit = true;
		let contentError: unknown = undefined;
		let editError: unknown = undefined;
		try {
			this._spec = reloaded;
			this._savedSpec = reloaded;
			try {
				this.fireContent({ previous, next: reloaded, label });
			} catch (e) {
				contentError = e;
			}
			// Megaudit-2 M3: same try/catch around fireEdit as in
			// applyEdit, for the same reason (preventing a subscriber
			// throw from masking contentError).
			try {
				this.fireEdit({
					label,
					// Megaudit-2 A1-M5: same guard as applyEdit's undo/redo
					// — reentrant applyEdit/applyReload from a content
					// subscriber must throw rather than corrupt state.
					undo: async () => {
						if (this._disposed) { return; }
						if (this._applyingEdit) {
							throw new ReentrantApplyEditError();
						}
						this._applyingEdit = true;
						try {
							this._spec = previous;
							this.fireContent({ previous: reloaded, next: previous, label: `undo ${label}` });
						} finally {
							this._applyingEdit = false;
						}
					},
					redo: async () => {
						if (this._disposed) { return; }
						if (this._applyingEdit) {
							throw new ReentrantApplyEditError();
						}
						this._applyingEdit = true;
						try {
							this._spec = reloaded;
							this.fireContent({ previous, next: reloaded, label: `redo ${label}` });
						} finally {
							this._applyingEdit = false;
						}
					},
				});
			} catch (e) {
				editError = e;
			}
		} finally {
			this._applyingEdit = false;
		}
		if (contentError !== undefined) {
			throw contentError;
		}
		if (editError !== undefined) {
			throw editError;
		}
	}

	/** Serialize the current spec for save/backup. */
	serializeCurrent(): Uint8Array {
		this.assertNotDisposed();
		return serializeSpec(this._spec);
	}

	dispose(): void {
		if (this._disposed) { return; }
		this._disposed = true;
		// Fire dispose handlers synchronously so subscribers can clean up
		// before the lists are cleared.
		for (const h of [...this.disposeHandlers]) {
			h();
		}
		this.contentHandlers.length = 0;
		this.editHandlers.length = 0;
		this.disposeHandlers.length = 0;
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private fireContent(e: ContentChangeEvent): void {
		for (const h of [...this.contentHandlers]) { h(e); }
	}

	private fireEdit(e: EditEvent): void {
		for (const h of [...this.editHandlers]) { h(e); }
	}

	private assertNotDisposed(): void {
		if (this._disposed) { throw new DisposedError(); }
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function removeOnce<T>(arr: T[], item: T): void {
	const idx = arr.indexOf(item);
	if (idx >= 0) { arr.splice(idx, 1); }
}

/** Deep-frozen clone of a spec. JSON-serialize + parse is the simplest
 *  correct deep-copy in this codebase (the spec is JSON-serializable by
 *  construction). */
function frozenClone(spec: QvizSpec): QvizSpec {
	const decoded = JSON.parse(new TextDecoder().decode(serializeSpec(spec))) as QvizSpec;
	deepFreeze(decoded);
	return decoded;
}

function deepFreeze<T>(obj: T): T {
	if (obj === null || typeof obj !== 'object') { return obj; }
	Object.freeze(obj);
	for (const key of Object.keys(obj)) {
		const v = (obj as Record<string, unknown>)[key];
		if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
			deepFreeze(v);
		}
	}
	return obj;
}

