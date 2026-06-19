/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave I (R13 + R14, 2026-06-19) -- the "Errors" diagnostics sidebar TreeDataProvider.
//
// Mirrors the DepGraphTreeProvider / LivePythonTreeProvider pattern: it renders the node model from the
// vscode-free {@link buildDiagnosticsNodes}. For the FOCUSED Cell Grid it reads the workbook's CURRENT
// diagnostics (the same data the W2 Problems-panel bridge tracks, via the read-only
// {@link DiagnosticsSource.currentDiagnostics} / {@link DiagnosticsSource.reactiveError}), resolves each
// sheet's live name, groups errors by sheet, and adapts each node to a TreeItem -- a distinct icon per
// error CLASS (R14 distinct markers) and the full `[code] message` (Python traceback included) in the
// tooltip (R14 traceback detail). A cell-error click reveals the cell in its workbook.
//
// Refresh signal: two pull events at construction -- a CellGrid "grids changed" event (focus/open/close/
// selection) and a "diagnostics changed" event (the QuantbookDiagnostics onDidChange). On either it fires
// onDidChangeTreeData and re-reads the focused workbook. No polling, no fabricated data. All vscode
// coupling lives here; the model + classification are pure + tested.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { CellDiagnostic } from '../diagnostics/diagnosticsLogic';
import {
	buildDiagnosticsNodes,
	type DiagnosticErrorClass,
	type DiagnosticsInput,
	type DiagnosticsNode,
} from '../diagnostics/diagnosticsTreeModel';
import type { SessionInstance } from '../types';

/** The command the "Errors" sidebar invokes to reveal a cell error in its workbook. Registered in
 *  {@link registerDiagnosticsView}; NOT a palette command (it is tree-invoked with by-reference args). */
export const REVEAL_CELL_COMMAND = 'quantlab.quantbookRevealCell';

/**
 * The read-only diagnostics surface the sidebar consults for the focused session. {@link QuantbookDiagnostics}
 * implements both methods directly; injecting this narrow interface keeps the provider decoupled from the
 * full bridge (and makes a fake trivial for a provider-level test).
 */
export interface DiagnosticsSource {
	/** The focused workbook's current per-sheet cell diagnostics (merged stored + sticky, stored-wins). */
	currentDiagnostics(session: SessionInstance): { sheet: number; diagnostics: CellDiagnostic[] }[];
	/** The focused workbook's current workbook-level reactive-kernel error, or `undefined`. */
	reactiveError(session: SessionInstance): string | undefined;
}

/** The error red used to tint every cell-error / reactive-error icon (matches the Problems panel). */
const ERROR_COLOR = new vscode.ThemeColor('problemsErrorIcon.foreground');

/** A distinct icon per error CLASS (R14 "distinct #PYTHON!/#BINDING! markers"), all tinted error-red. */
function iconForErrorClass(errorClass: DiagnosticErrorClass): vscode.ThemeIcon {
	switch (errorClass) {
		case 'python':
			return new vscode.ThemeIcon('flame', ERROR_COLOR);
		case 'binding':
			return new vscode.ThemeIcon('plug', ERROR_COLOR);
		case 'calc':
			return new vscode.ThemeIcon('symbol-operator', ERROR_COLOR);
		case 'name':
			return new vscode.ThemeIcon('question', ERROR_COLOR);
		case 'parse':
			return new vscode.ThemeIcon('edit', ERROR_COLOR);
		case 'generic':
			return new vscode.ThemeIcon('error', ERROR_COLOR);
	}
}

/** First line of a (possibly multi-line, e.g. Python traceback) message, for the compact node description. */
function firstLine(message: string): string {
	const nl = message.indexOf('\n');
	return nl === -1 ? message : message.slice(0, nl);
}

export class DiagnosticsTreeProvider implements vscode.TreeDataProvider<DiagnosticsNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<DiagnosticsNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	/** Maps each built cell-error node to the session it belongs to, so the reveal command carries the
	 *  error's OWN session by reference -- NOT a mutable "current focus" field (a focus flip between two
	 *  live workbooks mid-render could desync that, wiring node A's command to workbook B -> reveal in the
	 *  wrong workbook). Stamped at build time in {@link getChildren}; keyed by node identity (a WeakMap, so
	 *  a rebuilt tree's old nodes are GC'd). */
	private readonly nodeSession = new WeakMap<DiagnosticsNode, SessionInstance>();

	constructor(
		private readonly source: DiagnosticsSource,
		/** Fired on focus/open/close/selection change -- {@link CellGridPanel.onDidChangeGrids}. */
		onGridsChanged: (listener: () => void) => { dispose(): void },
		/** Fired when any diagnostic changes -- adapts {@link QuantbookDiagnostics.onDidChange} (per-uri). */
		onDiagnosticsChanged: (listener: () => void) => { dispose(): void },
	) {
		this.disposables.push(
			onGridsChanged(() => this.refresh()),
			onDiagnosticsChanged(() => this.refresh()),
		);
	}

	// --- TreeDataProvider interface ---

	getTreeItem(element: DiagnosticsNode): vscode.TreeItem {
		const collapsible = element.kind === 'sheetGroup'
			? vscode.TreeItemCollapsibleState.Expanded
			: vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(element.label, collapsible);
		item.id = element.id;

		switch (element.kind) {
			case 'noGrid':
				item.iconPath = new vscode.ThemeIcon('info');
				item.tooltip = 'Open or focus a Quantbook workbook to see its errors.';
				item.contextValue = 'quantlab.diagnostics.noGrid';
				break;

			case 'noErrors':
				item.iconPath = new vscode.ThemeIcon('pass');
				item.tooltip = 'This workbook currently has no cell or reactive errors.';
				item.contextValue = 'quantlab.diagnostics.noErrors';
				break;

			case 'reactiveError':
				item.iconPath = new vscode.ThemeIcon('zap', ERROR_COLOR);
				item.description = firstLine(element.message);
				item.tooltip = `Reactive kernel error:\n${element.message}`;
				item.contextValue = 'quantlab.diagnostics.reactiveError';
				break;

			case 'sheetGroup': {
				const plural = element.errorCount === 1 ? '' : 's';
				item.iconPath = new vscode.ThemeIcon('warning');
				item.description = `${element.errorCount} error${plural}`;
				item.tooltip = `${element.errorCount} error${plural} on ${element.label}.`;
				item.contextValue = 'quantlab.diagnostics.sheetGroup';
				break;
			}

			case 'cellError': {
				item.iconPath = iconForErrorClass(element.errorClass);
				item.description = firstLine(element.message);
				// Full detail (a Python traceback spans lines) lives in the tooltip (R14 traceback hover).
				item.tooltip = `[${element.code}] ${element.message}`;
				item.contextValue = 'quantlab.diagnostics.cellError';
				// Click -> reveal the cell in its OWN workbook. The session is read from the per-node stamp
				// (set in getChildren), NOT a mutable field, so a focus flip cannot retarget the command.
				const session = this.nodeSession.get(element);
				if (session !== undefined) {
					item.command = {
						command: REVEAL_CELL_COMMAND,
						title: 'Reveal Cell',
						arguments: [session, element.sheet, element.row, element.col],
					};
				}
				break;
			}
		}

		return item;
	}

	getChildren(element?: DiagnosticsNode): DiagnosticsNode[] {
		// Root -> the focused workbook's grouped diagnostics; a sheet group -> its cell-error leaves.
		if (element === undefined) {
			const { input, session } = this.computeInput();
			const roots = buildDiagnosticsNodes(input);
			// Stamp each cell-error node with the session it was built for, so its reveal command (set in
			// getTreeItem) targets the RIGHT workbook even if focus changes before VS Code asks for the item.
			if (session !== undefined) {
				for (const root of roots) {
					if (root.kind === 'sheetGroup') {
						for (const child of root.children) {
							this.nodeSession.set(child, session);
						}
					}
				}
			}
			return roots;
		}
		if (element.kind === 'sheetGroup') {
			return [...element.children];
		}
		return [];
	}

	// --- Focused-workbook model assembly ---

	/**
	 * Read the focused Cell Grid's current diagnostics into the pure model's input shape. A read failure here
	 * (e.g. a napi `listSheets()` throw on a faulted session) is surfaced LOUD per No-Fallbacks: we let it
	 * propagate to VS Code's tree error surface rather than show a healthy-looking empty sidebar over a broken
	 * session. The diagnostics read itself is pure data already mirrored to the Problems panel.
	 */
	private computeInput(): { input: DiagnosticsInput; session: SessionInstance | undefined } {
		const focused = CellGridPanel.focusedLocalPanel();
		if (focused === undefined) {
			return { input: { hasFocusedGrid: false, sheets: [], reactiveError: undefined }, session: undefined };
		}
		const { session } = focused;
		// Map sheet id -> live name so a group reads "Returns" not "Sheet 0"; a tombstoned sheet that still
		// carries diagnostics has no name (the model falls back to "Sheet <id>").
		const nameById = new Map(session.listSheets().map((s) => [s.id, s.name]));
		const sheets = this.source.currentDiagnostics(session).map(({ sheet, diagnostics }) => ({
			sheet,
			sheetName: nameById.get(sheet),
			diagnostics,
		}));
		return {
			input: { hasFocusedGrid: true, sheets, reactiveError: this.source.reactiveError(session) },
			session,
		};
	}

	// --- Lifecycle ---

	refresh(): void {
		if (!this.disposed) {
			this._onDidChangeTreeData.fire();
		}
	}

	dispose(): void {
		this.disposed = true;
		for (const d of this.disposables) {
			d.dispose();
		}
		this.disposables.length = 0;
		this._onDidChangeTreeData.dispose();
	}
}
