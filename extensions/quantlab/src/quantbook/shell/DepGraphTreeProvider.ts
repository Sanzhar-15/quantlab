/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 B3 dependency-graph sidebar -- the "Dependencies" TreeDataProvider.
//
// Mirrors the LivePythonTreeProvider pattern: it renders the node model from the vscode-free
// {@link buildDepGraphNodes}. It reads the FOCUSED Cell Grid's reported SELECTION (focus cell), pulls the
// owning Session's workbook snapshot to find that cell's formula, extracts its A1 precedents via the shared
// {@link extractFormulaRefs}, asks the reactive-kernel layer whether a published variable drives the cell,
// and formats those into nodes. All vscode coupling lives here; the model + ref extraction are pure + tested.
//
// Refresh signal: two pull events at construction -- a CellGrid "grids changed" event (focus/open/close/
// SELECTION change all fire onDidChangeGrids) and a reactive-kernel "kernel/published-cells changed" event.
// On either, it fires onDidChangeTreeData and re-reads the focused cell. No polling, no fabricated data.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import { columnLabelA1, formatCellTarget } from '../reactiveNotebook/bindVariableLogic';
import { extractFormulaRefs } from '../shared/extractFormulaRefs';
import type { PublishedRange } from '../reactiveKernel/publishedCellsStore';
import type { SessionInstance } from '../types';
import { buildDepGraphNodes, type DepGraphInput, type DepGraphNode, type PrecedentEdge } from './depGraphModel';

/**
 * The read-only kernel surface the sidebar consults for the focused session. The {@link ReactiveKernelManager}
 * implements both methods directly; injecting this narrow interface keeps the provider decoupled from the
 * manager's full lifecycle API (and makes a fake trivial for any provider-level test).
 */
export interface DepGraphKernelSource {
	/** Whether a live reactive kernel is currently registered for `session`. */
	hasKernel(session: SessionInstance): boolean;
	/** The cells each published variable drives on (`session`, `sheet`); `[]` when no kernel is registered. */
	publishedCellsForSheet(session: SessionInstance, sheet: number): PublishedRange[];
}

export class DepGraphTreeProvider implements vscode.TreeDataProvider<DepGraphNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<DepGraphNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly kernels: DepGraphKernelSource,
		/** Fired when the live-grid landscape OR the focused selection changes -- {@link CellGridPanel.onDidChangeGrids}. */
		onGridsChanged: (listener: () => void) => { dispose(): void },
		/** Fired when a kernel starts/stops or its published variables change -- {@link ReactiveKernelManager.onChange}. */
		onKernelChanged: (listener: () => void) => { dispose(): void },
	) {
		this.disposables.push(
			onGridsChanged(() => this.refresh()),
			onKernelChanged(() => this.refresh()),
		);
	}

	// --- TreeDataProvider interface ---

	getTreeItem(element: DepGraphNode): vscode.TreeItem {
		const collapsible = vscode.TreeItemCollapsibleState.None;
		const item = new vscode.TreeItem(element.label, collapsible);
		item.id = element.id;

		switch (element.kind) {
			case 'noSelection':
				item.iconPath = new vscode.ThemeIcon('info');
				item.tooltip = 'Select a cell in the focused Cell Grid to see what it depends on.';
				item.contextValue = 'quantlab.depGraph.noSelection';
				break;

			case 'focusedSheetMissing':
				item.iconPath = new vscode.ThemeIcon('warning');
				item.tooltip = 'The focused sheet was deleted out from under the open grid. '
					+ 'Dependencies cannot be read for a tombstoned sheet.';
				item.contextValue = 'quantlab.depGraph.focusedSheetMissing';
				break;

			case 'focusedCell':
				item.iconPath = new vscode.ThemeIcon('target');
				item.description = 'selected cell';
				item.tooltip = `Dependencies of ${element.cellLabel}.`;
				item.contextValue = 'quantlab.depGraph.focusedCell';
				break;

			case 'sectionHeader':
				item.iconPath = new vscode.ThemeIcon('list-tree');
				item.contextValue = 'quantlab.depGraph.section';
				break;

			case 'precedent':
				// A self/circular reference is the most notable case -> its own icon + description take priority
				// over the cross-sheet styling.
				item.iconPath = new vscode.ThemeIcon(
					element.self ? 'sync' : element.crossSheet ? 'references' : 'symbol-field',
				);
				item.description = element.self ? 'self / circular' : element.crossSheet ? 'cross-sheet' : undefined;
				item.tooltip = element.self
					? 'This cell\'s formula reads itself (a circular reference).'
					: `This cell's formula reads ${element.label}.`;
				item.contextValue = element.self ? 'quantlab.depGraph.precedent.self' : 'quantlab.depGraph.precedent';
				break;

			case 'pythonOwner':
				item.iconPath = new vscode.ThemeIcon('symbol-variable');
				item.tooltip = `A reactive Python variable "${element.variableName}" publishes onto this cell.`;
				item.contextValue = 'quantlab.depGraph.pythonOwner';
				break;

			case 'noDependencies':
				item.iconPath = new vscode.ThemeIcon('circle-slash');
				item.tooltip = 'This cell has no formula precedents and is not driven by a reactive variable.';
				item.contextValue = 'quantlab.depGraph.noDependencies';
				break;

			case 'formulaError':
				item.iconPath = new vscode.ThemeIcon('error');
				item.description = element.detail;
				item.tooltip = `Could not read this cell's formula precedents: ${element.detail}`;
				item.contextValue = 'quantlab.depGraph.formulaError';
				break;

			case 'sqlDeferred':
				item.iconPath = new vscode.ThemeIcon('database');
				item.tooltip = 'SQL-query -> cell lineage is not tracked yet (no target-tracking in the engine). '
					+ 'Shown so the gap is explicit, never as a fabricated edge.';
				item.contextValue = 'quantlab.depGraph.sqlDeferred';
				break;
		}

		return item;
	}

	getChildren(element?: DepGraphNode): DepGraphNode[] {
		// Flat list (v1): only the root has children; every node is a leaf.
		if (element !== undefined) {
			return [];
		}
		return buildDepGraphNodes(this.computeInput());
	}

	// --- Focused-cell model assembly ---

	/**
	 * Read the focused cell + its formula + its reactive owner into the pure model's input shape. A render
	 * failure here (e.g. a napi `workbookSnapshot()`/`listSheets()` throw on a faulted session) is surfaced
	 * LOUD per No-Fallbacks: we let it propagate to VS Code's tree error surface rather than show a healthy-
	 * looking empty sidebar over a broken session.
	 */
	private computeInput(): DepGraphInput {
		const focused = CellGridPanel.focusedGridSelection();
		if (focused === undefined) {
			return {
				focusedCellLabel: undefined,
				focusedSheetMissing: false,
				focusedFormula: undefined,
				formulaError: undefined,
				precedents: [],
				kernelRunning: false,
				pythonOwner: undefined,
			};
		}

		const { session, sheet, selection } = focused;
		// The "focused cell" is the selection's FOCUS corner (the active cell). A range selection still has a
		// single active cell; v1 shows that cell's dependencies (a multi-cell dependency rollup is a future cut).
		const focusRow = selection.focusRow;
		const focusCol = selection.focusCol;

		const sheets = session.listSheets();
		const focusedSheet = sheets.find((s) => s.id === sheet);
		// The focused sheet was deleted out from under the open grid (a real race) -> surface that explicitly
		// (No-Fallbacks). We do NOT fabricate a display sheet name + render a healthy-looking "no deps" view.
		if (focusedSheet === undefined) {
			return {
				focusedCellLabel: formatCellTarget(`Sheet ${sheet}`, focusRow, focusCol),
				focusedSheetMissing: true,
				focusedFormula: undefined,
				formulaError: undefined,
				precedents: [],
				kernelRunning: false,
				pythonOwner: undefined,
			};
		}
		// The focused sheet's name qualifies the focused cell label + is the baseline for cross-sheet detection.
		const focusedSheetName = focusedSheet.name;
		const focusedCellLabel = formatCellTarget(focusedSheetName, focusRow, focusCol);

		// Read the focused cell's formula from the workbook snapshot. A formula-only OR formula-bearing cell
		// carries `.formula`; a pure literal / empty cell does not (CellSnapshotJson contract).
		const formula = this.readCellFormula(session, sheet, focusRow, focusCol);
		// A stored snapshot formula is engine-valid by construction (setFormula rejects malformed input at
		// write time). But we still gate on the ENGINE validator (the same lexer that stored it) so a
		// malformed formula is SURFACED, never silently dropped to "no dependencies" (No-Fallbacks): this is
		// the authoritative malformed-formula check, superior to letting the pure tokenizer guess. On a
		// non-empty error diagnostic we emit a formulaError node + skip precedent extraction.
		const formulaError = formula === undefined ? undefined : this.formulaError(session, sheet, focusRow, focusCol, formula);
		const precedents = formula === undefined || formulaError !== undefined
			? []
			: this.resolvePrecedents(formula, focusedSheetName, focusRow, focusCol);

		// (b) Reverse Python edge: is a published variable driving THIS cell? Only meaningful with a kernel.
		const kernelRunning = this.kernels.hasKernel(session);
		const pythonOwner = kernelRunning
			? this.findPythonOwner(session, sheet, focusRow, focusCol)
			: undefined;

		return {
			focusedCellLabel,
			focusedSheetMissing: false,
			focusedFormula: formula,
			formulaError,
			precedents,
			kernelRunning,
			pythonOwner,
		};
	}

	/**
	 * Ask the ENGINE whether the focused cell's formula is malformed, returning the first error diagnostic's
	 * `[code] message` or `undefined` if it is valid. `session.validateFormula` parses + binds WITHOUT
	 * mutating and returns diagnostics as DATA (an empty array = valid); we surface only `severity === 'error'`
	 * diagnostics (a `warning`/`info` is not a "could not read precedents" condition). A `validateFormula`
	 * THROW propagates (No-Fallbacks) -- a faulted session must not look healthy. This is the No-Fallbacks
	 * authority for "a malformed formula is surfaced, not dropped": the same engine lexer that stored the
	 * formula judges it, so there is no tokenizer-divergence blind spot.
	 */
	private formulaError(session: SessionInstance, sheet: number, row: number, col: number, formula: string): string | undefined {
		const diagnostics = session.validateFormula(sheet, row, col, formula);
		const firstError = diagnostics.find((d) => d.severity === 'error');
		return firstError === undefined ? undefined : `[${firstError.code}] ${firstError.message}`;
	}

	/**
	 * The focused cell's formula body (no leading `=`), or `undefined` for a literal/empty cell. Reads the
	 * owning session's workbook snapshot and finds the cell on the focused sheet. A snapshot/listSheets throw
	 * propagates (No-Fallbacks). A tombstoned focused sheet (absent from the snapshot) -> `undefined` (no
	 * formula to read -- the focused-cell label already marks the sheet deleted).
	 */
	private readCellFormula(session: SessionInstance, sheet: number, row: number, col: number): string | undefined {
		const snapshot = session.snapshot();
		const sheetSnap = snapshot.sheets.find((s) => s.id === sheet);
		if (sheetSnap === undefined) {
			// The focused sheet is missing from the snapshot. computeInput already returned the explicit
			// focusedSheetMissing state before reaching here, so this is a defensive guard, not a masked state.
			return undefined;
		}
		const cell = sheetSnap.cells.find((c) => c.row === row && c.col === col);
		return cell?.formula;
	}

	/**
	 * Extract + resolve the focused cell's direct precedents: run the shared {@link extractFormulaRefs} over
	 * the formula, qualify each ref with its sheet (an unqualified ref is same-sheet), format a sheet-
	 * qualified A1 target, de-duplicate (a `=A1+A1` shows one `A1`), and FLAG a self-reference (a cell that
	 * reads itself -- a circular dependency). The self-reference is KEPT + flagged, not dropped: it is a real
	 * dependency/cycle signal the user should see (No-Fallbacks: surface, do not omit). Cross-sheet edges are
	 * flagged too. (The de-dupe key is the target; a cell can be both a self-ref and a normal ref only if it
	 * appears twice -- first occurrence wins, and a same-cell ref is always the self-ref.)
	 */
	private resolvePrecedents(
		formula: string,
		focusedSheetName: string,
		focusRow: number,
		focusCol: number,
	): PrecedentEdge[] {
		const refs = extractFormulaRefs(formula);
		const byTarget = new Map<string, PrecedentEdge>();
		for (const ref of refs) {
			// An unqualified ref resolves to the focused cell's own sheet. A qualified ref carries the sheet
			// name VERBATIM from the formula (possibly quoted, e.g. `'My Sheet'`); we normalize a single-quoted
			// qualifier for display + cross-sheet comparison but keep the engine's name semantics.
			const refSheetName = ref.sheet === undefined ? focusedSheetName : normalizeSheetQualifier(ref.sheet);
			const target = `${refSheetName}!${columnLabelA1(ref.col)}${ref.row + 1}`;
			const crossSheet = refSheetName !== focusedSheetName;
			// A self-reference: the focused cell reading itself on its own sheet (a circular dependency). Kept
			// + flagged so the cycle is visible, never silently dropped.
			const self = !crossSheet && ref.row === focusRow && ref.col === focusCol;
			if (!byTarget.has(target)) {
				byTarget.set(target, { target, crossSheet, self });
			}
		}
		// Preserve source order (Map iteration follows insertion order).
		return [...byTarget.values()];
	}

	/**
	 * The reactive variable publishing onto the focused cell, or `undefined` if none drives it. Scans the
	 * session's published ranges on the focused sheet (the reverse of the Live-Python var -> cell map) and
	 * returns the FIRST range that CONTAINS the cell -- the kernel's G2 guard keeps published regions non-
	 * overlapping, so at most one matches (first-match is unambiguous). `[]` ranges -> `undefined`.
	 */
	private findPythonOwner(session: SessionInstance, sheet: number, row: number, col: number): string | undefined {
		const ranges = this.kernels.publishedCellsForSheet(session, sheet);
		for (const r of ranges) {
			if (row >= r.startRow && row <= r.endRow && col >= r.startCol && col <= r.endCol) {
				return r.name;
			}
		}
		return undefined;
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

/**
 * Normalize a sheet-name qualifier from a formula for DISPLAY + cross-sheet comparison: strip the
 * surrounding single quotes of a quoted name (`'My Sheet'` -> `My Sheet`) and un-double an escaped `''`
 * (`'O''Brien'` -> `O'Brien`). An unquoted name passes through verbatim. This matches how the engine's
 * sheet names display (the snapshot's `SheetInfoJson.name` is the un-quoted form), so a quoted same-sheet
 * ref `'S0'!A1` compares equal to the focused sheet `S0` and is NOT mis-flagged as cross-sheet.
 */
function normalizeSheetQualifier(qualifier: string): string {
	if (qualifier.length >= 2 && qualifier.startsWith('\'') && qualifier.endsWith('\'')) {
		return qualifier.slice(1, -1).replace(/''/g, '\'');
	}
	return qualifier;
}
