/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W2 error-surface -- the HOST-side bridge that mirrors Quantbook cell errors into VS Code's Problems
// panel via ONE `vscode.languages.createDiagnosticCollection('quantbook')`.
//
// THREE error sources feed it (all over the EXISTING per-panel diagnostics apparatus -- no 2nd
// pollEvents cursor):
//   1. STORED cell errors -- the diagnostic-decorated render snapshot's `kind:'error'` cells
//      (CellGridPanel.render() -> setSheetCellDiagnostics). Authoritative + auto-clearing: a recovered
//      cell is no longer an error entry, so the next render replaces the sheet's uri list without it.
//   2. INPUT-REJECTION errors -- a putValue/formula that fails to parse never gets written, so it is
//      ABSENT from the snapshot; it arrives as an `errorReply` (sheet,row,col,code,message). Tracked
//      sticky per (session,sheet,cell) and cleared when that cell next commits cleanly (onAck /
//      onCellsWritten) or its panel disposes.
//   3. WORKBOOK-LEVEL reactive errors -- a reactive `onError(message)` carries NO cell address, so it is
//      surfaced at a (0,0) range under a per-session `quantbook://.../reactive` uri, cleared when the
//      kernel recovers (a publish frame lands) or stops.
//
// Navigation: a `quantbook://` TextDocumentContentProvider (registered in extension.ts) serves a
// readable virtual doc per uri, so clicking a diagnostic in the Problems panel opens a real document.
//
// No-Fallbacks: nothing is fabricated; a cleared error clears its collection entry; a reactive error
// with no location is workbook-level, never pinned to a wrong cell.

import * as vscode from 'vscode';

import type { QuantbookCellSnapshot, SessionInstance } from '../types';
import {
	buildCellDiagnosticsFromSnapshot,
	cellDiagnosticsUriPath,
	formatCellLocationLabel,
	reactiveDiagnosticsUriPath,
	renderCellDiagnosticsDoc,
	renderReactiveDiagnosticsDoc,
	type CellDiagnostic,
} from './diagnosticsLogic';

export const QUANTBOOK_DIAGNOSTICS_SCHEME = 'quantbook';

/** Map key for a sticky errorReply within one sheet. */
function cellKey(row: number, col: number): string {
	return `${row},${col}`;
}

/**
 * Merge one sheet's STORED cell errors with its sticky input-rejection (`errorReply`) entries: stored
 * errors always win on the same cell (the cell was (re)written, so the rejection is moot). Pure -- returns
 * the merged list (stored first, then non-superseded sticky in insertion order) plus the sticky keys a
 * stored error now SUPERSEDES, so the (mutating) emit path can DELETE them while a (read-only) query path
 * ignores them. Shared by {@link QuantbookDiagnostics.emitMerged} (drops the superseded) and
 * {@link QuantbookDiagnostics.currentDiagnostics} (the Wave I "Errors" tree) so the two never diverge.
 */
function mergeStoredAndSticky(
	stored: readonly CellDiagnostic[],
	sheetSticky: Map<string, CellDiagnostic> | undefined,
): { merged: CellDiagnostic[]; superseded: string[] } {
	const storedKeys = new Set(stored.map(d => cellKey(d.row, d.col)));
	const merged: CellDiagnostic[] = [...stored];
	const superseded: string[] = [];
	if (sheetSticky !== undefined) {
		for (const [key, diag] of sheetSticky) {
			if (storedKeys.has(key)) {
				superseded.push(key);
				continue;
			}
			merged.push(diag);
		}
	}
	return { merged, superseded };
}

/**
 * The Quantbook DiagnosticCollection bridge + its `quantbook://` virtual-doc content provider. ONE
 * instance is constructed at activation, injected into `CellGridPanel` (a static sink) and the
 * reactive-kernel layer, and disposed via `context.subscriptions`.
 */
export class QuantbookDiagnostics implements vscode.TextDocumentContentProvider, vscode.Disposable {
	private readonly collection: vscode.DiagnosticCollection;

	/** Stable, sanitized tag per live session (so two workbooks on the same sheet id never share a uri).
	 *  A WeakMap so a closed/GC'd session's tag is released with it. */
	private readonly sessionTags = new WeakMap<SessionInstance, string>();
	private nextSessionTag = 1;

	/** Sticky input-rejection (`errorReply`) diagnostics, keyed `sessionTag` -> `sheet` -> `"row,col"`.
	 *  Cleared when the cell next commits cleanly or its panel/session goes away. */
	private readonly stickyErrorReplies = new Map<string, Map<number, Map<string, CellDiagnostic>>>();

	/** Last STORED cell-error list per `sessionTag` -> `sheet`, captured at each `render()` push. Retained
	 *  so a sticky-map mutation OUTSIDE a render (a clear from onAck, a new errorReply) can re-merge the
	 *  stored errors without dropping them and without re-deriving them from `vscode.Diagnostic`. The next
	 *  render replaces it. */
	private readonly lastStored = new Map<string, Map<number, CellDiagnostic[]>>();

	/** Latest workbook-level reactive error message per `sessionTag` (absent = none). One message per
	 *  session (latest-wins): the reactive `onError` is a bare string with no cell, and a kernel surfaces
	 *  one fault at a time. */
	private readonly reactiveErrors = new Map<string, string>();

	/** Current virtual-doc body per uri string, so `provideTextDocumentContent` is O(1) + always matches
	 *  what the diagnostic points at. Removed when its diagnostics clear. */
	private readonly docBodies = new Map<string, string>();
	private readonly onDidChangeEmitter = new vscode.EventEmitter<vscode.Uri>();
	readonly onDidChange = this.onDidChangeEmitter.event;

	constructor() {
		this.collection = vscode.languages.createDiagnosticCollection(QUANTBOOK_DIAGNOSTICS_SCHEME);
	}

	/** Stable per-session tag (sanitized to `[A-Za-z0-9]` -- it lands in a uri path). Assigned lazily on
	 *  first use and memoized for the session's lifetime. */
	private sessionTag(session: SessionInstance): string {
		let tag = this.sessionTags.get(session);
		if (tag === undefined) {
			tag = `s${this.nextSessionTag}`;
			this.nextSessionTag += 1;
			this.sessionTags.set(session, tag);
		}
		return tag;
	}

	private cellUri(sessionTag: string, sheet: number): vscode.Uri {
		const { authority, path } = cellDiagnosticsUriPath(sessionTag, sheet);
		return vscode.Uri.from({ scheme: QUANTBOOK_DIAGNOSTICS_SCHEME, authority, path });
	}

	private reactiveUri(sessionTag: string): vscode.Uri {
		const { authority, path } = reactiveDiagnosticsUriPath(sessionTag);
		return vscode.Uri.from({ scheme: QUANTBOOK_DIAGNOSTICS_SCHEME, authority, path });
	}

	/** Build a single-cell `vscode.Diagnostic` (Error severity) for a cell-scoped diagnostic. The range
	 *  is one cell wide on `row`; clicking it opens the sheet's virtual doc. */
	private toVscodeDiagnostic(sheet: number, d: CellDiagnostic): vscode.Diagnostic {
		const range = new vscode.Range(d.row, d.col, d.row, d.col + 1);
		const diag = new vscode.Diagnostic(
			range,
			`${formatCellLocationLabel(sheet, d.row, d.col)}: [${d.code}] ${d.message}`,
			vscode.DiagnosticSeverity.Error,
		);
		diag.source = 'quantbook';
		diag.code = d.code;
		return diag;
	}

	/**
	 * Replace one sheet's CELL diagnostics from a diagnostic-decorated render snapshot (source 1). The
	 * sticky `errorReply` entries (source 2) for the same sheet are merged on top -- a stored error and a
	 * pending input-rejection can coexist on different cells. A stored error on a cell that ALSO has a
	 * stale sticky entry supersedes it (the sticky is dropped: the cell now has a real stored value/error,
	 * so the rejection no longer applies). Called from `CellGridPanel.render()`.
	 */
	setSheetCellDiagnostics(session: SessionInstance, sheet: number, snapshot: QuantbookCellSnapshot): void {
		const tag = this.sessionTag(session);
		const stored = buildCellDiagnosticsFromSnapshot(snapshot);
		// Retain the stored set so a later sticky-map mutation outside a render can re-merge it.
		let storedBySheet = this.lastStored.get(tag);
		if (storedBySheet === undefined) {
			storedBySheet = new Map();
			this.lastStored.set(tag, storedBySheet);
		}
		storedBySheet.set(sheet, stored);
		this.emitMerged(tag, sheet);
	}

	/** Re-emit one sheet's merged STORED + sticky cell diagnostics. A sticky errorReply on a cell that now
	 *  has a STORED error is DELETED from the sticky map (its rejection is moot -- the cell was (re)written),
	 *  not merely hidden from the emitted list. Hiding-without-deleting (Codex HIGH) would resurrect the
	 *  stale sticky if the stored error later recovers via a path that does not commit that exact cell
	 *  (e.g. a dependent formula recompute clears it). Stored errors always win on the same cell. */
	private emitMerged(tag: string, sheet: number): void {
		const stored = this.lastStored.get(tag)?.get(sheet) ?? [];
		const sheetSticky = this.stickyErrorReplies.get(tag)?.get(sheet);
		const { merged, superseded } = mergeStoredAndSticky(stored, sheetSticky);
		// A stored error now covers these cells -> drop the superseded sticky entries ENTIRELY, not merely
		// hide them from the emitted list (Codex HIGH): hiding-without-deleting would resurrect the stale
		// sticky if the stored error later recovers via a path that does not commit that exact cell.
		if (sheetSticky !== undefined) {
			for (const key of superseded) {
				sheetSticky.delete(key);
			}
		}
		this.publishCellDiagnostics(tag, sheet, merged);
	}

	/**
	 * Record an input-rejection `errorReply` (source 2) as a sticky cell diagnostic. It persists until the
	 * cell commits cleanly (`clearCellErrorReply`) or its panel/session goes away, because a rejected edit
	 * leaves the cell's prior value unchanged -- there is no render that would otherwise clear it.
	 */
	setCellErrorReply(session: SessionInstance, sheet: number, row: number, col: number, code: string, message: string): void {
		const tag = this.sessionTag(session);
		let bySheet = this.stickyErrorReplies.get(tag);
		if (bySheet === undefined) {
			bySheet = new Map();
			this.stickyErrorReplies.set(tag, bySheet);
		}
		let byCell = bySheet.get(sheet);
		if (byCell === undefined) {
			byCell = new Map();
			bySheet.set(sheet, byCell);
		}
		byCell.set(cellKey(row, col), { row, col, code, message });
		this.emitMerged(tag, sheet);
	}

	/** Clear a sticky errorReply for a cell that committed cleanly (called from `onAck`/`onCellsWritten`). */
	clearCellErrorReply(session: SessionInstance, sheet: number, row: number, col: number): void {
		const tag = this.sessionTag(session);
		const byCell = this.stickyErrorReplies.get(tag)?.get(sheet);
		if (byCell === undefined || !byCell.delete(cellKey(row, col))) {
			return;
		}
		this.emitMerged(tag, sheet);
	}

	private publishCellDiagnostics(tag: string, sheet: number, diagnostics: CellDiagnostic[]): void {
		const uri = this.cellUri(tag, sheet);
		if (diagnostics.length === 0) {
			this.collection.delete(uri);
			this.docBodies.delete(uri.toString());
		} else {
			this.collection.set(uri, diagnostics.map(d => this.toVscodeDiagnostic(sheet, d)));
			this.docBodies.set(uri.toString(), renderCellDiagnosticsDoc(sheet, diagnostics));
		}
		this.onDidChangeEmitter.fire(uri);
	}

	/**
	 * Set the WORKBOOK-LEVEL reactive error for a session (source 3). A reactive `onError` is a bare
	 * string with no cell address, so it is pinned at a (0,0) range under a per-session reactive uri --
	 * NEVER to a guessed cell (No-Fallbacks). Latest-wins.
	 */
	setReactiveError(session: SessionInstance, message: string): void {
		const tag = this.sessionTag(session);
		this.reactiveErrors.set(tag, message);
		this.publishReactive(tag);
	}

	/** Clear a session's workbook-level reactive error (the kernel recovered or stopped). */
	clearReactiveError(session: SessionInstance): void {
		const tag = this.sessionTag(session);
		if (this.reactiveErrors.delete(tag)) {
			this.publishReactive(tag);
		}
	}

	private publishReactive(tag: string): void {
		const uri = this.reactiveUri(tag);
		const message = this.reactiveErrors.get(tag);
		if (message === undefined) {
			this.collection.delete(uri);
			this.docBodies.delete(uri.toString());
		} else {
			const diag = new vscode.Diagnostic(
				new vscode.Range(0, 0, 0, 0),
				`Reactive kernel: ${message}`,
				vscode.DiagnosticSeverity.Error,
			);
			diag.source = 'quantbook';
			diag.code = 'reactive';
			this.collection.set(uri, [diag]);
			this.docBodies.set(uri.toString(), renderReactiveDiagnosticsDoc([message]));
		}
		this.onDidChangeEmitter.fire(uri);
	}

	/**
	 * Drop ALL diagnostics for one (session, sheet) -- called when a Cell Grid panel disposes so a closed
	 * sheet leaves no stale Problems entries. Clears the sheet's stored+sticky cell diagnostics.
	 */
	clearSheet(session: SessionInstance, sheet: number): void {
		const tag = this.sessionTag(session);
		this.stickyErrorReplies.get(tag)?.delete(sheet);
		this.lastStored.get(tag)?.delete(sheet);
		const uri = this.cellUri(tag, sheet);
		this.collection.delete(uri);
		this.docBodies.delete(uri.toString());
		this.onDidChangeEmitter.fire(uri);
	}

	/**
	 * Drop ALL diagnostics for a session (every sheet + its reactive error) -- called when a session's
	 * LAST panel closes / the session is closed. Iterates the sticky map's known sheets + the reactive uri.
	 */
	clearSessionAll(session: SessionInstance): void {
		const tag = this.sessionTag(session);
		// Union of every sheet that has stored and/or sticky diagnostics for this session.
		const sheets = new Set<number>();
		for (const s of this.stickyErrorReplies.get(tag)?.keys() ?? []) {
			sheets.add(s);
		}
		for (const s of this.lastStored.get(tag)?.keys() ?? []) {
			sheets.add(s);
		}
		for (const sheet of sheets) {
			const uri = this.cellUri(tag, sheet);
			this.collection.delete(uri);
			this.docBodies.delete(uri.toString());
			this.onDidChangeEmitter.fire(uri);
		}
		this.stickyErrorReplies.delete(tag);
		this.lastStored.delete(tag);
		this.reactiveErrors.delete(tag);
		const reactiveUri = this.reactiveUri(tag);
		this.collection.delete(reactiveUri);
		this.docBodies.delete(reactiveUri.toString());
		this.onDidChangeEmitter.fire(reactiveUri);
	}

	// --- Wave I (R13/R14): read API for the "Errors" diagnostics sidebar ---
	// READ-ONLY queries over the SAME tracked state the Problems panel mirrors (no new error tracking, no
	// side effects -- in particular they do NOT allocate a session tag for an unseen session, unlike the
	// mutating setters: a session with no diagnostics yet simply reports none). The sidebar refreshes off
	// the existing {@link onDidChange} emitter.

	/**
	 * The focused workbook's current per-sheet cell diagnostics (merged STORED + sticky, stored-wins),
	 * sheet id ascending, only sheets that have errors. Empty for a session with no diagnostics. Pure read
	 * (the merge mirrors {@link emitMerged} via the shared {@link mergeStoredAndSticky}, but never deletes
	 * the superseded sticky entries -- a query must not mutate; the next emit does the cleanup).
	 */
	currentDiagnostics(session: SessionInstance): { sheet: number; diagnostics: CellDiagnostic[] }[] {
		const tag = this.sessionTags.get(session);
		if (tag === undefined) {
			return [];
		}
		const sheets = new Set<number>();
		for (const s of this.lastStored.get(tag)?.keys() ?? []) {
			sheets.add(s);
		}
		for (const s of this.stickyErrorReplies.get(tag)?.keys() ?? []) {
			sheets.add(s);
		}
		const out: { sheet: number; diagnostics: CellDiagnostic[] }[] = [];
		for (const sheet of [...sheets].sort((a, b) => a - b)) {
			const stored = this.lastStored.get(tag)?.get(sheet) ?? [];
			const sheetSticky = this.stickyErrorReplies.get(tag)?.get(sheet);
			const { merged } = mergeStoredAndSticky(stored, sheetSticky);
			if (merged.length > 0) {
				out.push({ sheet, diagnostics: merged });
			}
		}
		return out;
	}

	/** The focused workbook's current workbook-level reactive-kernel error, or `undefined` if none. Pure read. */
	reactiveError(session: SessionInstance): string | undefined {
		const tag = this.sessionTags.get(session);
		if (tag === undefined) {
			return undefined;
		}
		return this.reactiveErrors.get(tag);
	}

	/** {@link vscode.TextDocumentContentProvider} -- serve the readable body for a `quantbook://` uri so a
	 *  Problems-panel click opens a real document. Returns the stored body, or an empty-state body if the
	 *  diagnostics already cleared (the doc may still be opened from history). */
	provideTextDocumentContent(uri: vscode.Uri): string {
		const body = this.docBodies.get(uri.toString());
		if (body !== undefined) {
			return body;
		}
		return 'Quantbook errors\n\nNo current errors for this location.\n';
	}

	dispose(): void {
		this.collection.dispose();
		this.onDidChangeEmitter.dispose();
		this.docBodies.clear();
		this.stickyErrorReplies.clear();
		this.lastStored.clear();
		this.reactiveErrors.clear();
	}
}
