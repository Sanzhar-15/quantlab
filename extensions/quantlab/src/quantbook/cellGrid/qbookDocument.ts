/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * **Wave H2 (R10 part 2/2, 2026-06-19) -- `vscode.CustomDocument` backing the `.qbook`
 * custom editor.**
 *
 * A `QbookDocument` OWNS the napi `Session` for one open `.qbook` file: it opens the session
 * from disk in {@link QbookDocument.create} and closes it in {@link QbookDocument.dispose}.
 * (The grid {@link CellGridPanel} adopted by the provider's `resolveCustomEditor` is bound to
 * this session with `ownsSession:false`, so the panel's own dispose does NOT close the session
 * -- VS Code can dispose+recreate the webview independently of the document.)
 *
 * **Dirty tracking is signature-based, not edit-event based.** The owning engine `Session`
 * already owns Ctrl+Z/Y (its Loro undo stack), so this document deliberately does NOT use
 * `CustomDocumentEditEvent` (which would put edits on VS Code's undo stack and fight the
 * engine's undo -- double-undo). Instead it fires `CustomDocumentContentChangeEvent` (dirty-only)
 * and tracks a composite {@link ContentSignature}:
 *   - the opaque per-session delta-cache `version` token (a Loro version vector) -- covers
 *     cell / style / format / hidden-rows ops;
 *   - a stable key over the workbook's defined names -- a SEPARATE axis because `setName` /
 *     `deleteName` are token-INVISIBLE (they do NOT advance the version token; see types.ts).
 * Every grid mutation re-renders, which pulses {@link recomputeDirty}; the document compares the
 * current signature against the one captured at the last save/open and -- on a clean->dirty
 * transition only -- fires the content-change event (VS Code clears dirty itself on save/revert;
 * a ContentChangeEvent can only MARK dirty, never signal clean).
 *
 * **Known limitation (by design):** the version is a Loro version vector, so undoing back to the
 * saved state leaves a DIFFERENT frontier than the saved version -- the tab stays dirty even
 * though the content matches disk. A content-hash baseline would be the (heavier) v2 fix.
 *
 * Engine-touching operations are injected as {@link QbookDocumentDeps} so the document stays
 * unit-testable (no live engine / vscode-webview host needed).
 */

import * as vscode from 'vscode';

import type { SessionInstance } from '../types';

/**
 * A composite dirty fingerprint of the workbook. The {@link ContentSignature.version} token covers
 * cell/style/format/hidden-rows mutations; {@link ContentSignature.namesKey} is a SEPARATE axis
 * because `setName`/`deleteName` are explicitly token-invisible (see `types.ts` -- defined-name
 * changes do not advance the version token, so a version-only compare would miss them and the tab
 * could stay clean over an unsaved name edit = data loss).
 */
export interface ContentSignature {
	readonly version: Buffer | undefined;
	readonly namesKey: string;
}

/**
 * The engine-touching operations a {@link QbookDocument} needs, injected so the document stays
 * unit-testable (a stub supplies a fake session + signature source). The provider supplies the
 * real implementations.
 */
export interface QbookDocumentDeps {
	/** Open a fresh owning `Session` from a single-file `.qbook` at `path` (throws loud on a bad
	 *  file; closes the partial session on failure). */
	openWorkbook(path: string): SessionInstance;
	/** Read the session's current content signature (version token + defined-names key) -- the
	 *  dirty signal. `version` is `undefined` before the first render seeds the cache. */
	readSignature(session: SessionInstance): ContentSignature;
	/** Close + release a session this document owns (drops diagnostics, tears down a bound
	 *  reactive kernel, then `session.close()`). Idempotent. */
	closeSession(session: SessionInstance): void;
}

/**
 * Whether two content signatures differ (the dirty signal): the defined-names key changed OR the
 * version token advanced. Exported for unit testing.
 */
export function signaturesDiffer(saved: ContentSignature, current: ContentSignature): boolean {
	if (saved.namesKey !== current.namesKey) {
		return true;
	}
	return versionsDiffer(saved.version, current.version);
}

/**
 * Version-token compare (the cell/style/format/hidden-rows axis). Exported for unit testing.
 *
 * - Both `undefined` (pre-baseline seed, before the version is captured) -> equal.
 * - Exactly one side `undefined` -> differ.
 * - Both present -> differ iff the bytes differ.
 *
 * NOTE the known limitation: a Loro version vector is not monotonic by content, so undoing back to
 * the saved state produces a DIFFERENT token than `saved` and this returns `true` (the tab stays
 * modified). That is intentional for v1.
 */
export function versionsDiffer(saved: Buffer | undefined, current: Buffer | undefined): boolean {
	if (saved === undefined && current === undefined) {
		return false;
	}
	if (saved === undefined || current === undefined) {
		return true;
	}
	return !bytesEqual(saved, current);
}

export class QbookDocument implements vscode.CustomDocument {

	/**
	 * Open a `.qbook` into a fresh owning session.
	 *
	 * - `openContext.untitledDocumentData` (a "New Untitled File" of type `.qbook`) is REFUSED
	 *   loud -- there is no in-memory `.qbook` bytes path; the demo command + Save As is how a
	 *   new workbook is materialized (Wave H2 additive scope).
	 * - `openContext.backupId` (hot-exit restore) opens from the BACKUP path (the engine
	 *   discriminates a container by its `quantbook-container` sentinel, not the file extension,
	 *   so a hashed backup file round-trips).
	 * - Otherwise opens from `uri`.
	 *
	 * A bad/missing file throws (the provider lets it propagate so VS Code surfaces "failed to
	 * open"). An opened-but-empty workbook is refused loud (No-Fallbacks -- never show a phantom
	 * sheet 0), mirroring the `quantlab.quantbookOpen` command's guard.
	 */
	static create(
		uri: vscode.Uri,
		openContext: vscode.CustomDocumentOpenContext,
		deps: QbookDocumentDeps,
	): QbookDocument {
		if (openContext.untitledDocumentData !== undefined) {
			throw new Error(
				'[not_implemented] Untitled .qbook documents are not supported. ' +
				'Use "Quantbook: Open Cell Grid" to create a workbook, then Save As a .qbook file.',
			);
		}
		const sourcePath = openContext.backupId !== undefined
			? vscode.Uri.parse(openContext.backupId).fsPath
			: uri.fsPath;
		const session = deps.openWorkbook(sourcePath);
		// The opened workbook MUST have a live sheet -- never show a phantom sheet 0 for an
		// empty/corrupt workbook (No-Fallbacks). Both the empty-sheet refusal and a listSheets()
		// throw off an unreadable state close the freshly-opened session ONCE in the catch (so its
		// engine handle is not leaked) before rethrowing.
		let firstSheet: number;
		try {
			const sheets = session.listSheets();
			if (sheets.length === 0) {
				throw new Error(`[persistence] Quantbook open failed: "${uri.fsPath}" has no live sheets.`);
			}
			firstSheet = sheets[0].id;
		} catch (err) {
			deps.closeSession(session);
			throw err;
		}
		return new QbookDocument(uri, session, firstSheet, deps);
	}

	private readonly _onDidDispose = new vscode.EventEmitter<void>();
	readonly onDidDispose = this._onDidDispose.event;

	/**
	 * Fires when the tab should be marked MODIFIED. The provider relays it to its
	 * `_onDidChangeCustomDocument` (a `CustomDocumentContentChangeEvent` emitter), which VS Code
	 * treats as "content changed -> dirty" (it has no "now clean" counterpart; clean is cleared by
	 * the workbench on save/revert). So this fires ONLY on a clean->dirty transition (or a
	 * {@link reassertDirty} after a failed revert) -- NEVER to signal clean.
	 */
	private readonly _onDidChangeContent = new vscode.EventEmitter<void>();
	readonly onDidChangeContent = this._onDidChangeContent.event;

	/** The content signature captured at the last save/open baseline. `undefined` until the first
	 *  {@link markSavedNow} (which runs after the panel's first render seeds the delta cache). */
	private savedSignature: ContentSignature | undefined = undefined;
	/** The last-reported dirty state, so {@link recomputeDirty} only fires on a clean->dirty edge. */
	private wasDirty = false;
	/** True once {@link markSavedNow} has established a baseline. Before that (the window between
	 *  open and the first render) {@link recomputeDirty} no-ops, so the seed render -- which may
	 *  produce a non-empty version token -- does not spuriously mark the fresh document dirty. */
	private baselineEstablished = false;
	private _disposed = false;

	private constructor(
		readonly uri: vscode.Uri,
		/** The owning napi session. MUTABLE: {@link swapSession} replaces it on revert (open
		 *  is once-only, so revert opens a fresh session and rebinds). */
		private _session: SessionInstance,
		/** The first live sheet id to show, captured at open. */
		readonly firstSheet: number,
		private readonly deps: QbookDocumentDeps,
	) { }

	/** The owning session (read by the provider for save/backup + adopt). */
	get session(): SessionInstance {
		return this._session;
	}

	/** Whether the document currently has unsaved changes (the modified indicator). */
	get isDirty(): boolean {
		return this.wasDirty;
	}

	/**
	 * Recompute dirty from the current content signature vs the saved baseline. Wired as the
	 * per-render `onMutate` pulse on the adopted {@link CellGridPanel}. Fires the content-change
	 * event ONLY on a clean->dirty transition (VS Code clears dirty itself on save/revert; an
	 * organic return-to-baseline -- e.g. a name added then removed -- updates internal state
	 * WITHOUT firing, so the tab stays modified until a real save/revert: a safe over-report,
	 * never data loss). No-ops before a baseline is established and after dispose.
	 */
	recomputeDirty(): void {
		if (this._disposed || !this.baselineEstablished || this.savedSignature === undefined) {
			return;
		}
		const dirty = signaturesDiffer(this.savedSignature, this.deps.readSignature(this._session));
		if (dirty && !this.wasDirty) {
			this.wasDirty = true;
			this._onDidChangeContent.fire();
		} else if (!dirty && this.wasDirty) {
			this.wasDirty = false;
		}
	}

	/**
	 * Establish the clean baseline ONCE, after the first open render. Unlike {@link markSavedNow},
	 * this is a no-op once a baseline already exists -- so a webview recreate (VS Code re-calls
	 * `resolveCustomEditor` when the tab is moved to another editor group, or shown after a
	 * retain-context teardown) does NOT reset the baseline and silently lose a pending dirty state.
	 * The session (hence its delta-cache version) persists across the recreate, so the existing
	 * baseline stays correct.
	 */
	ensureInitialBaseline(): void {
		if (!this.baselineEstablished) {
			this.markSavedNow();
		}
	}

	/**
	 * Capture the current content signature as the saved baseline (the document is now CLEAN).
	 * Called after each successful save and after a revert re-render (revert first suspends the
	 * baseline via {@link swapSession}). Does NOT fire a content-change event -- VS Code clears its
	 * own dirty state on save/revert (a ContentChangeEvent would only MARK dirty).
	 *
	 * No-Fallbacks: the version token is REQUIRED to detect cell/style/format/hidden-rows edits.
	 * The engine populates `snapshot()`/`snapshotDelta()` version after a render (see the
	 * quantbook-session "carries an opaque version" test). An undefined version at baseline means a
	 * broken engine build where those edits cannot be detected -> throw loud rather than silently
	 * never-dirty (which would suppress the close save-prompt = data loss).
	 */
	markSavedNow(): void {
		const signature = this.deps.readSignature(this._session);
		if (signature.version === undefined) {
			throw new Error(
				'[invalid_state] QbookDocument: the engine produced no version token after a render; ' +
				'the .qbook editor cannot track unsaved changes. Rebuild the engine dylib.',
			);
		}
		this.savedSignature = signature;
		this.baselineEstablished = true;
		this.wasDirty = false;
	}

	/**
	 * Re-mark the document dirty after a FAILED revert. The workbench clears a custom editor's
	 * dirty state synchronously and fire-and-forget when the user runs Revert (it neither awaits
	 * `revertCustomDocument` nor honors its throw -- see `mainThreadCustomEditors` `revert`). The
	 * unsaved edits are still live in the session, so re-fire the content-change signal to restore
	 * the modified indicator -- otherwise a clean-looking tab would silently drop them on close.
	 * Always fires (even when already dirty) because the workbench may have just cleared the flag.
	 */
	reassertDirty(): void {
		if (this._disposed) {
			return;
		}
		this.wasDirty = true;
		this._onDidChangeContent.fire();
	}

	/**
	 * **Conservative dirty failsafe.** Wired as the adopted panel's `onRenderError` -- fired when
	 * `CellGridPanel.render()`'s snapshot acquire THROWS (build drift / schema / merge), so the
	 * precise version-based {@link recomputeDirty} cannot compute a signal. A mutation may have
	 * committed before that render, so mark the document dirty to avoid a falsely-clean tab over a
	 * committed-but-unrenderable edit (a safe over-report -- a pure-view render that fails would only
	 * over-dirty, never lose data; the render failure itself is surfaced loud by `safeRender`). Fires
	 * ONLY on a clean->dirty edge (no spam if a broken build keeps failing every render).
	 */
	markDirtyConservatively(): void {
		if (this._disposed || this.wasDirty) {
			return;
		}
		this.wasDirty = true;
		this._onDidChangeContent.fire();
	}

	/**
	 * **Revert support.** Swap in a freshly-opened session (the old one is torn down by the
	 * provider via `CellGridPanel.detachForRevert`) and suspend the dirty baseline until the
	 * next {@link markSavedNow} (after the re-render seeds the fresh session's delta cache).
	 * Called BEFORE the old session is closed (gap #7: a debounced backup mid-revert must hit
	 * the fresh, open session -- not the closing old one).
	 */
	swapSession(fresh: SessionInstance): void {
		this._session = fresh;
		this.baselineEstablished = false;
	}

	dispose(): void {
		if (this._disposed) {
			return;
		}
		this._disposed = true;
		// Fire BEFORE closing the session so the provider tears down its per-document tracking
		// (and the panel's own dispose runs its registry cleanup) while the session is still
		// open; then release the session (idempotent -- the panel never closes it on this path).
		this._onDidDispose.fire();
		this._onDidDispose.dispose();
		this._onDidChangeContent.dispose();
		this.deps.closeSession(this._session);
	}
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) {
		return false;
	}
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) {
			return false;
		}
	}
	return true;
}
