/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * QvizSpecDocument -- vscode.CustomDocument backing a `.qviz.json` editor.
 *
 * Phase 5 step A.2 (audit-merged plan). Thin vscode adapter around
 * `SpecDocumentCore` (in `src/qviz/specDocCore.ts`) which owns the
 * lifecycle state machine (spec / savedSpec / dirty / undo-redo /
 * reentrancy / dispose). The split lets us unit-test the lifecycle from
 * plain mocha; this file is concerned with vscode integration only:
 *
 *   - Bridging core's content-change / edit / dispose events into
 *     `vscode.EventEmitter` instances that VS Code listens to.
 *   - Filesystem I/O for create / saveAs / revert / backup.
 *   - `vscode.CustomDocumentBackup` shape for hot-exit recovery.
 *
 * Validation invariants (audit-fix M4):
 *   - `parseSpecBytes` rejects malformed bytes / non-JSON / invalid spec
 *     at create-time.
 *   - `SpecDocumentCore.applyEdit` validates `next` before accepting; an
 *     invalid edit throws and `_spec` stays at its prior value.
 *   - Save serializes the in-memory spec without re-validating. By
 *     induction every value of the core's `spec` is the result of a
 *     successful validation, so re-validation on save is redundant.
 */

import * as vscode from 'vscode';

import { parseSpecBytes, serializeSpec } from '../../qviz/specCore';
import {
	type ContentChangeEvent, type EditEvent, type Unsubscribe,
	SpecDocumentCore,
} from '../../qviz/specDocCore';
import { type QvizSpec, QVIZ_SCHEMA_VERSION } from '../../qviz/spec';
import { structurallyEqual } from '../../qviz/structuralEqual';
import { PLACEHOLDER_SCHEMA_HASH } from '../../qviz/draftFromDataset';

/**
 * Smoke-test fix (2026-05-11): default skeleton used when a user opens
 * a 0-byte `.qviz.json` (the natural "create new file" path). Must
 * pass `validateOrThrow` -- which means a syntactically valid
 * `sha256:<64 hex>` schema_hash, every mandatory provenance field, and
 * a chart shape the validator accepts. None of these placeholders
 * point at real data; the builder UI's first user action (assigning a
 * dataset URI + dragging a column to x/y) replaces them before the
 * user ever needs to save.
 *
 * The all-zeros schema_hash satisfies the regex without colliding with
 * any legitimate sha256 of real data -- on first schema fetch the
 * drift detector will flag a mismatch and the user can refresh
 * provenance via the save-with-refresh path. The constant is owned by
 * `draftFromDataset.ts` so dataset-side and document-side drafts
 * stay structurally aligned by construction.
 */
function defaultDraftSpec(): QvizSpec {
	// Front 3 (2026-05-13 post-smoke): no schema is known when an
	// empty `.qviz.json` is opened, so we seed with NO encodings
	// rather than literal placeholder field names `x` / `y`.
	// Placeholder fields produced "field 'x' not in column data"
	// rejections from the renderer the moment a real dataset got
	// associated, and made the local renderer compile fail
	// repeatedly during builder edits. With empty encodings the
	// renderer cleanly reports "line chart requires encodings.x and
	// encodings.y" until the user assigns columns via the column-
	// panel or drag-drop — at which point `inferEncodingTypeForChannel`
	// (Pattern B) sets the correct schema-derived encoding type.
	//
	// `deriveDefaultSpec(...)` in `src/qviz/defaults.ts` (called via
	// `draftFromDataset.ts`) remains the schema-aware seeder for the
	// "Open as Visualise" path where the dataset is known up front.
	return {
		qviz_version: QVIZ_SCHEMA_VERSION,
		title: '',
		dataset: {
			uri: '',
			schema_hash: PLACEHOLDER_SCHEMA_HASH,
			mtime_ns: 0,
			row_count: 0,
		},
		transforms: [],
		chart: {
			family: 'timeseries',
			type: 'line',
			encodings: {},
		},
		provenance: {
			generator: 'manual',
			generated_at: new Date().toISOString(),
			query_hash: '',
			tool_versions: { qviz_schema: QVIZ_SCHEMA_VERSION },
			source: 'user-built',
		},
	};
}

export interface QvizSpecDocumentDelegate {
	getDocumentData(uri: vscode.Uri): Promise<Uint8Array>;
}

/** Step 5.I.4: thrown by saveAs when on-disk content changed
 *  externally between open and save. The provider catches and
 *  prompts the user. */
export class SaveConflictError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'SaveConflictError';
	}
}

/** Megaudit CRITICAL-11: thrown by saveAsTransformed when the
 *  in-memory spec was edited (via applyEdit from the webview) DURING
 *  the await on writeFile. The transformed-spec disk content no longer
 *  matches the user's latest edits; we surface rather than silently
 *  call applyReload(transformed) and discard the edit. */
export class MidSaveEditError extends Error {
	constructor(fsPath: string) {
		super(
			`The spec was edited during save of ${fsPath}. `
			+ 'The save was rolled back; please retry.',
		);
		this.name = 'MidSaveEditError';
	}
}

export interface QvizSpecChangeEvent extends ContentChangeEvent {
	readonly document: QvizSpecDocument;
}

export class QvizSpecDocument implements vscode.CustomDocument {

	/**
	 * Construct a document.
	 *
	 * Audit-fix M7: accepts the real `vscode.CustomDocumentOpenContext` so
	 * `untitledDocumentData` (used for "New Untitled File" flows) is
	 * honored. Without this, opening an untitled `.qviz.json` would call
	 * `delegate.getDocumentData(uri)` on a nonexistent file and throw.
	 */
	static async create(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		delegate: QvizSpecDocumentDelegate,
	): Promise<QvizSpecDocument> {
		let bytes: Uint8Array;
		let sourceLabel: string;
		let onDiskAtOpen: Uint8Array | null = null;
		if (openContext.untitledDocumentData !== undefined) {
			bytes = openContext.untitledDocumentData;
			sourceLabel = `${uri.toString()} (untitled)`;
			// No "on-disk" baseline for untitled docs; first save
			// won't trigger a conflict prompt.
		} else if (openContext.backupId) {
			const backupUri = vscode.Uri.parse(openContext.backupId);
			bytes = await delegate.getDocumentData(backupUri);
			sourceLabel = `${backupUri.toString()} (backup)`;
			// Restoring a backup: load the actual on-disk file separately
			// to seed the conflict baseline. Only treat a real
			// "file does not exist" as legitimate "no baseline"; any other
			// error (permission, transient I/O, corruption) MUST propagate
			// so we don't silently disable the conflict-detection gate
			// for the document's lifetime (megaudit MAJOR-3).
			try {
				onDiskAtOpen = await delegate.getDocumentData(uri);
			} catch (e) {
				if (!isFileNotFoundError(e)) { throw e; }
				onDiskAtOpen = null;
			}
		} else {
			bytes = await delegate.getDocumentData(uri);
			sourceLabel = uri.toString();
			onDiskAtOpen = bytes;
		}
		// Smoke-test fix (2026-05-11): a 0-byte `.qviz.json` -- the natural
		// "create file → start editing" UX -- previously hit `JSON.parse('')`
		// and the editor refused to open. Treat empty bytes as "draft new
		// spec": seed a default skeleton, set `onDiskAtOpen = null` so the
		// first save is treated as a fresh create (no conflict-baseline
		// against the empty file). The user can fill in the dataset URI
		// through the builder UI and `Cmd+S` writes a real spec to disk.
		// Backups (`openContext.backupId`) are NEVER empty-by-design --
		// that branch was already handled above and is intentionally
		// skipped here.
		let spec: QvizSpec;
		if (bytes.byteLength === 0 && openContext.untitledDocumentData === undefined && !openContext.backupId) {
			spec = defaultDraftSpec();
			onDiskAtOpen = null;
		} else {
			spec = parseSpecBytes(bytes, sourceLabel);
		}
		return new QvizSpecDocument(uri, spec, onDiskAtOpen);
	}

	private readonly core: SpecDocumentCore;
	private readonly subs: Unsubscribe[] = [];

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	private readonly _onDidChange = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<QvizSpecDocument>>();
	/** Fires for each edit. VS Code uses this to drive the editor's
	 *  "modified" indicator and the undo stack. */
	readonly onDidChange = this._onDidChange.event;

	private readonly _onDidChangeContent = new vscode.EventEmitter<QvizSpecChangeEvent>();
	/** Fires when the in-memory spec changes (edit / save / revert). The
	 *  provider listens to this to push the new spec to the webview. */
	readonly onDidChangeContent = this._onDidChangeContent.event;

	/** Step 5.I.4: bytes that were on disk when this document was
	 *  opened (or last successfully saved). Save flow compares against
	 *  this to detect external modification before overwriting. */
	private lastKnownDiskBytes: Uint8Array | null;

	private constructor(
		readonly uri: vscode.Uri,
		initial: QvizSpec,
		onDiskAtOpen: Uint8Array | null,
	) {
		this.core = new SpecDocumentCore(initial);
		this.lastKnownDiskBytes = onDiskAtOpen;
		this.subs.push(
			this.core.onContentChange(e => this._onDidChangeContent.fire({ ...e, document: this })),
			this.core.onEdit(e => this._onDidChange.fire(this.toCustomDocumentEditEvent(e))),
		);
	}

	/** Snapshot of bytes the document last knew were on disk. The
	 *  provider's save flow uses this to detect external modification
	 *  (Step 5.I.4). Null only for untitled docs that have never been
	 *  saved. */
	get knownDiskBytes(): Uint8Array | null {
		return this.lastKnownDiskBytes;
	}

	get spec(): QvizSpec { return this.core.spec; }
	get savedSpec(): QvizSpec { return this.core.savedSpec; }
	get isDirty(): boolean { return this.core.isDirty; }

	applyEdit(next: QvizSpec, label: string): void {
		this.core.applyEdit(next, label);
	}

	async saveAs(
		targetUri: vscode.Uri,
		options: { skipConflictCheck?: boolean } = {},
	): Promise<void> {
		if (!options.skipConflictCheck) {
			await this.assertNoExternalChange(targetUri);
			await this.assertSaveAsTargetClear(targetUri);
		}
		const saved = this.core.captureForSave();
		const bytes = this.core.serializeCurrent();
		await vscode.workspace.fs.writeFile(targetUri, bytes);
		await this.assertWrittenBytesMatch(targetUri, bytes);
		this.core.markSaved(saved);
		this.lastKnownDiskBytes = bytes;
	}

	/**
	 * Save a TRANSFORMED version of the current spec, atomic against
	 * disk-write failure. Used by the drift-aware save path: if the
	 * disk write fails, neither the in-memory `_spec` nor `_savedSpec`
	 * advance (no state divergence). On success, both move forward to
	 * the transformed value via `applyReload`, which fires the content
	 * event so the webview updates and registers an undo entry.
	 *
	 * Step C megaudit C8: prior provider code applied the edit BEFORE
	 * the disk write, leaving the undo stack and ctx state in a
	 * "drift resolved" position when the disk write actually failed.
	 * `saveAsTransformed` makes the disk write the gating step.
	 */
	async saveAsTransformed(
		targetUri: vscode.Uri,
		transform: (spec: QvizSpec) => QvizSpec,
		options: { skipConflictCheck?: boolean } = {},
	): Promise<QvizSpec> {
		if (!options.skipConflictCheck) {
			await this.assertNoExternalChange(targetUri);
			await this.assertSaveAsTargetClear(targetUri);
		}
		const captured = this.core.captureForSave();
		const transformed = transform(captured);
		const bytes = serializeSpec(transformed);
		// Megaudit-2 CODEX-8: check for mid-save in-memory edits BEFORE
		// the disk write (was: AFTER). The previous order let the disk
		// write commit, then threw MidSaveEditError, leaving disk with
		// the older transformed spec while memory had the newer edit
		// AND `lastKnownDiskBytes` un-updated -- so the next save would
		// false-positive a SaveConflictError. The error message said
		// "rolled back" but no rollback happened. Now the check fires
		// pre-write, so a thrown MidSaveEditError genuinely leaves disk
		// untouched.
		if (!structurallyEqual(this.core.spec, captured)) {
			throw new MidSaveEditError(targetUri.fsPath);
		}
		// Disk write is the gate: if this throws, nothing in the document
		// or core has been mutated yet.
		await vscode.workspace.fs.writeFile(targetUri, bytes);
		await this.assertWrittenBytesMatch(targetUri, bytes);
		// Re-check after the await -- a fast user could have edited
		// during the (potentially slow) writeFile. If they did, the
		// disk now has the transformed version and memory has newer
		// content; surface as MidSaveEditError so the user retries.
		if (!structurallyEqual(this.core.spec, captured)) {
			throw new MidSaveEditError(targetUri.fsPath);
		}
		// applyReload sets _spec AND _savedSpec to `transformed` (so the
		// document is NOT dirty after save) and fires content + edit
		// events so the webview reflects the post-save state.
		this.core.applyReload(transformed, 'save: transformed');
		this.lastKnownDiskBytes = bytes;
		return transformed;
	}

	/**
	 * Step 5.I.4: read the target file's current content; if it
	 * differs from what we last knew was on disk, throw
	 * `SaveConflictError` so the provider can prompt the user
	 * (Overwrite vs Cancel).
	 *
	 * Skipped if:
	 *   - target URI is different from `this.uri` (Save As to a new
	 *     file is never a conflict).
	 *   - `lastKnownDiskBytes` is null (untitled doc, never saved
	 *     against a baseline).
	 *   - target doesn't exist (no conflict -- caller is creating it).
	 */
	private async assertNoExternalChange(targetUri: vscode.Uri): Promise<void> {
		if (targetUri.toString() !== this.uri.toString()) { return; }
		if (this.lastKnownDiskBytes === null) { return; }
		let current: Uint8Array;
		try {
			current = await vscode.workspace.fs.readFile(targetUri);
		} catch (e) {
			// Only swallow "file doesn't exist" -- that's a legitimate
			// "no in-place conflict, the write will create it fresh".
			// Anything else (EACCES, transient I/O, corruption) MUST
			// propagate so the user sees the real error rather than us
			// silently bypassing the conflict gate (megaudit MAJOR-2).
			if (isFileNotFoundError(e)) { return; }
			throw e;
		}
		if (bytesEqual(current, this.lastKnownDiskBytes)) { return; }
		throw new SaveConflictError(
			`The file ${this.uri.fsPath} was changed on disk since it was opened. `
			+ 'Saving now would overwrite those changes.',
		);
	}

	/**
	 * Megaudit CRITICAL-7: when saving to a target distinct from
	 * `this.uri` (Save As), `assertNoExternalChange` short-circuits
	 * because `lastKnownDiskBytes` is keyed on the original URI. That
	 * leaves a hole: Save As to an existing file silently overwrites it.
	 * Surface the existing target as a conflict so the provider's
	 * Overwrite/Cancel prompt fires.
	 */
	private async assertSaveAsTargetClear(targetUri: vscode.Uri): Promise<void> {
		if (targetUri.toString() === this.uri.toString()) { return; }
		let existing: Uint8Array;
		try {
			existing = await vscode.workspace.fs.readFile(targetUri);
		} catch (e) {
			if (isFileNotFoundError(e)) { return; }
			throw e;
		}
		if (existing.length === 0) { return; }
		throw new SaveConflictError(
			`The file ${targetUri.fsPath} already exists. `
			+ 'Saving as that file would overwrite its contents.',
		);
	}

	/**
	 * Megaudit CRITICAL-11 (post-write half of TOCTOU defense):
	 * after `writeFile`, re-read the target and verify the bytes match
	 * what we intended to write. A mismatch means another process wrote
	 * to the same path during our write -- we MUST surface that rather
	 * than report "save succeeded" when our content is gone.
	 */
	private async assertWrittenBytesMatch(
		targetUri: vscode.Uri, expected: Uint8Array,
	): Promise<void> {
		const actual = await vscode.workspace.fs.readFile(targetUri);
		if (bytesEqual(actual, expected)) { return; }
		throw new SaveConflictError(
			`The file ${targetUri.fsPath} was modified by another process `
			+ 'during the save. Reload and retry.',
		);
	}

	async revert(delegate: QvizSpecDocumentDelegate): Promise<void> {
		const bytes = await delegate.getDocumentData(this.uri);
		if (this.core.isDisposed) { return; }
		const reloaded = parseSpecBytes(bytes, this.uri.toString());
		// Megaudit-2 A2-CRITICAL-4: update `lastKnownDiskBytes` BEFORE
		// `applyReload`. The reload mutates `_savedSpec = reloaded`
		// before firing events; if a content subscriber throws, the
		// throw escapes applyReload (via the final fix's try/catch +
		// re-throw) and the lastKnownDiskBytes assignment is never
		// reached. The next save then compares the new disk content
		// to the stale baseline → false-positive SaveConflictError.
		// `applyReload` either commits both halves of state OR neither;
		// pre-setting lastKnownDiskBytes mirrors that atomicity.
		this.lastKnownDiskBytes = bytes;
		this.core.applyReload(reloaded, 'revert');
	}

	async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
		const bytes = this.core.serializeCurrent();
		await vscode.workspace.fs.writeFile(destination, bytes);
		return {
			id: destination.toString(),
			delete: () => {
				// Audit-fix M2: log delete failures rather than swallow.
				// CLAUDE.md system-boundary exception requires logging the
				// underlying error; the prior empty `catch {}` discarded it.
				vscode.workspace.fs.delete(destination).then(undefined, (err) => {
					console.warn(
						`QvizSpecDocument: backup delete failed for ${destination.toString()}: `,
						err,
					);
				});
			},
		};
	}

	dispose(): void {
		if (this.core.isDisposed) { return; }
		for (const u of this.subs) { u(); }
		this.subs.length = 0;
		this.core.dispose();
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		this._onDidChange.dispose();
		this._onDidChangeContent.dispose();
	}

	private toCustomDocumentEditEvent(
		e: EditEvent,
	): vscode.CustomDocumentEditEvent<QvizSpecDocument> {
		return {
			document: this,
			label: e.label,
			undo: e.undo,
			redo: e.redo,
		};
	}
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) { return false; }
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) { return false; }
	}
	return true;
}

/** Detect "file does not exist" errors across both the Node `fs` shim
 *  used in tests (which sets `code = 'ENOENT'`) and the production
 *  `vscode.FileSystemError.FileNotFound` (which sets `.code` to
 *  `'FileNotFound'`). Megaudit MAJOR-2 / MAJOR-3: callers MUST
 *  distinguish "file gone" from any other I/O error so they don't
 *  silently bypass the conflict gate on a transient failure.
 *
 *  Megaudit-2 A2-M8: the prior implementation also checked
 *  `err.name`, but VS Code's `FileSystemError` inherits `'Error'`
 *  from the parent and only sets `.code`. Checking `.name` was dead
 *  code that suggested a fallback that doesn't actually exist. */
function isFileNotFoundError(e: unknown): boolean {
	if (e === null || typeof e !== 'object') { return false; }
	const err = e as { code?: unknown };
	return err.code === 'ENOENT' || err.code === 'FileNotFound';
}
