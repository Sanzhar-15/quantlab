/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-1) -- the NotebookController for `quantlab-reactive-notebook` (`.qnb`).
//
// The thin vscode layer over ReactiveNotebookRegistry (binding/lifetime/serialization, all unit-tested)
// and the EXISTING ReactiveKernelManager (trust-gated, lazy-spawned, cursor-unified). A notebook code
// cell -> manager.executeCell(boundSession, code) -> the same publish/recalc/refreshSession path the
// programmatic command already uses; the grid repaints through the client's onChanged. The controller
// adds NO second writer or cursor.
//
// Session resolution for N-1 (the explicit "Bind to selected cell" command is N-2): bind-on-first-execute
// to the FOCUSED grid (focused-wins / ambiguous-abort, the FE-2-0 host-audit discipline). The binding is
// torn down (detached) when that Session closes (Codex HIGH-1 lifetime fix), and a cell that runs against
// a detached notebook fails loud with a reopen-to-rebind error -- never against a dead Session.
//
// v1 output is the op STATUS (recompute count + G3 refusals + stale names) plus kernel/host errors. Full
// per-cell `print()` stdout is deferred: executeCell returns counts only, and the kernel's stdout is a
// diagnostics ring without op boundaries -- faking per-cell stdout would be dishonest (Codex MED-2).

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import { resolveCommandTargetPanel } from '../cellGrid/cellGridLogic';
import type { SessionInstance } from '../types';
import type { ReactiveKernelManager } from '../reactiveKernel/reactiveKernelManager';
import { QNB_NOTEBOOK_TYPE } from './qnbSerializer';
import { formatOpStatus, NotebookWorkbookClosedError, partialStatusFromError, ReactiveNotebookRegistry } from './reactiveNotebookRegistry';
import { buildBindPublishRangeCellSource, formatRangeTarget, isPublishableSheetName, isValidPublishVariableName, normalizeSelectionRect } from './bindVariableLogic';

const CONTROLLER_ID = 'quantlab-reactive-kernel';
const CONTROLLER_LABEL = 'Quantbook Reactive Kernel';

/** Resolve the focused Cell Grid's owning Session, throwing a clear error (surfaced in the cell output)
 *  when there is no grid or the target is ambiguous -- the bind-on-first-execute resolver. */
function resolveFocusedGridSession(): SessionInstance {
	const panels = CellGridPanel.activeLocalPanels();
	if (panels.length === 0) {
		throw new Error('[no_cell_grid] open a Cell Grid (Quantbook: Open Cell Grid) before running a reactive notebook cell');
	}
	const resolution = resolveCommandTargetPanel(panels, CellGridPanel.focusedLocalPanel());
	if (resolution.kind === 'ambiguous') {
		// Clicking the notebook Run button blurs the grid, so "click the grid then re-run" loops back to
		// ambiguous (and clicking the grid de-focuses the notebook, which the Bind command needs active).
		// The honest recovery: keep THIS notebook focused and run the Bind command -- it prompts for the grid.
		throw new Error(
			'[ambiguous_cell_grid] multiple Cell Grids are open; this notebook cannot tell which to bind to. '
			+ 'With this notebook focused, run "Quantbook: Bind Reactive Notebook to Grid" (it prompts you to pick the grid), '
			+ 'or leave only the target grid open, then run the cell again',
		);
	}
	return resolution.session;
}

/** Resolve the Cell Grid an operator COMMAND should target. Returns the single / focused grid directly;
 *  with multiple grids and none focused -- which is the norm when binding FROM an active notebook editor,
 *  because focusing a grid de-focuses the notebook (and vice versa) -- it offers a QuickPick so the command
 *  is never a dead end (Codex N-2 MED-1). Returns undefined + an info toast when no grid is open or the
 *  operator dismisses the pick. */
async function pickTargetGrid(): Promise<{ session: SessionInstance; sheet: number } | undefined> {
	const panels = CellGridPanel.activeLocalPanels();
	if (panels.length === 0) {
		void vscode.window.showInformationMessage('No Cell Grid is open. Run "Quantbook: Open Cell Grid" first.');
		return undefined;
	}
	if (panels.length === 1) {
		return panels[0];
	}
	const focused = CellGridPanel.focusedLocalPanel();
	if (focused !== undefined) {
		return focused;
	}
	// More than one panel and none focused (the norm when acting from an active notebook, which de-focuses
	// every grid): let the operator choose the exact panel. We do NOT defer to resolveCommandTargetPanel
	// here -- it auto-picks panels[0] for multiple panels of the SAME workbook (correct for workbook-level
	// commands), but the seed/bind here is SHEET-specific, so two sheet panels of one workbook are distinct
	// choices the operator must make (Codex N-2 re-audit MED). Label each by its active sheet; snapshot() is
	// NOT wrapped in a fallback -- a broken session must surface, not be silently labelled blank.
	const items = panels.map((p, i) => {
		const snap = p.session.snapshot();
		const sh = snap.sheets.find((s) => s.id === p.sheet);
		const detail = sh !== undefined
			? `active sheet ${sh.name} (${snap.sheets.length} sheet${snap.sheets.length === 1 ? '' : 's'})`
			: `${snap.sheets.length} sheet${snap.sheets.length === 1 ? '' : 's'}`;
		return { label: `Cell Grid ${i + 1}`, detail, panel: p };
	});
	const chosen = await vscode.window.showQuickPick(items, {
		placeHolder: 'Multiple Cell Grids are open -- choose which to bind this reactive notebook to',
	});
	return chosen?.panel;
}

/** The name of `sheet` on `session` (e.g. "S0"), used to pre-fill a publish target so the seeded cell is
 *  correct out of the box (the operator-stalling S0-vs-Sheet1 gotcha). Throws loud if the id is gone. */
function activeSheetName(session: SessionInstance, sheet: number): string {
	const found = session.snapshot().sheets.find((s) => s.id === sheet);
	if (found === undefined) {
		throw new Error(`[bad_sheet] the focused grid has no sheet with id ${sheet}`);
	}
	return found.name;
}

/** True iff `session` is still backed by a live (non-disposed) Cell Grid panel. The bind commands await a
 *  QuickPick / openNotebookDocument; the chosen grid can CLOSE during that gap, and binding a closed
 *  Session would clear the tombstone and store a dead handle that `resolveForExecute` then hands out as
 *  "live" -- the explicit-bind analog of the HIGH-1 dead-session hazard (megaudit). Callers re-validate
 *  with this immediately before `bindNotebook`, with NO await in between, so the check cannot itself race. */
function isLiveGridSession(session: SessionInstance): boolean {
	return CellGridPanel.activeLocalPanels().some((p) => p.session === session);
}

/** The seed cells for a newly opened reactive notebook: a one-line how-it-works note + a runnable publish
 *  template targeting the focused grid's active sheet so the very first Run mutates the grid (no guessing).
 *  The sheet name is interpolated via JSON.stringify so a name containing a quote / backslash / newline
 *  produces a valid Python string literal rather than breaking the cell source (Codex N-2 MED-2); it is
 *  NOT placed raw in the comment for the same reason. */
function seedNotebookCells(sheetName: string): vscode.NotebookCellData[] {
	const intro = '# Reactive Python -- bound to the focused Quantbook grid\n\n'
		+ 'Edit a value below and run the cell. `qb.publish(name, value, "Sheet!Cell")` writes a variable '
		+ 'into the grid; dependent cells recompute live. Re-running with a new value updates them.';
	const target = JSON.stringify(`${sheetName}!B1`);
	const code = '# Change x, then run this cell -- the target cell (and anything that references it) updates.\n'
		+ 'x = 42\n'
		+ `qb.publish("x", x, ${target})`;
	return [
		new vscode.NotebookCellData(vscode.NotebookCellKind.Markup, intro, 'markdown'),
		new vscode.NotebookCellData(vscode.NotebookCellKind.Code, code, 'python'),
	];
}

/**
 * Register the reactive NotebookController + its lifetime listeners. Call once from `activate` AFTER the
 * kernel manager is built (it drives `manager.executeCell`). All disposables go through
 * `context.subscriptions`, so deactivate releases the controller and unregisters the listeners.
 */
export function registerReactiveNotebookController(
	context: vscode.ExtensionContext,
	manager: ReactiveKernelManager<SessionInstance>,
	resolveSession: () => SessionInstance = resolveFocusedGridSession,
): vscode.NotebookController {
	const registry = new ReactiveNotebookRegistry<SessionInstance>();
	const controller = vscode.notebooks.createNotebookController(CONTROLLER_ID, QNB_NOTEBOOK_TYPE, CONTROLLER_LABEL);
	controller.supportedLanguages = ['python'];
	controller.supportsExecutionOrder = true;
	controller.description = 'Reactive Python bound to the focused Quantbook grid';

	let executionOrder = 0;

	controller.executeHandler = async (cells: vscode.NotebookCell[]): Promise<void> => {
		// Cells in one request run in order; awaiting each (the registry also serializes per-Session across
		// requests) keeps the single kernel client free of concurrent ops.
		for (const cell of cells) {
			// Defensive: only code cells execute (supportedLanguages already restricts this, but a Run-All
			// could in principle include a markdown cell -- skip it rather than open an execution for it).
			if (cell.kind !== vscode.NotebookCellKind.Code) {
				continue;
			}
			const lifetimeFault = await executeCell(cell);
			if (lifetimeFault) {
				// Codex HIGH: the bound workbook closed. ABORT the rest of this Run All -- never let a later
				// cell in the SAME user action rebind to a different grid and mutate the wrong workbook.
				break;
			}
		}
	};

	/** Execute one code cell. Returns true iff it failed because the bound workbook closed (a lifetime
	 *  fault) -- the signal for executeHandler to abort the rest of the run. */
	async function executeCell(cell: vscode.NotebookCell): Promise<boolean> {
		const exec = controller.createNotebookCellExecution(cell);
		exec.executionOrder = ++executionOrder;
		exec.start(Date.now());
		await exec.clearOutput();
		const uri = cell.notebook.uri.toString();
		const code = cell.document.getText();
		try {
			// Resolve (bind-on-first-execute) OUTSIDE the queue so a no-grid / ambiguous / detached error
			// surfaces on this cell immediately; the live-check inside the queue closes the resolve->close race.
			const session = registry.resolveForExecute(uri, resolveSession);
			const result = await registry.serialize(session, async () => {
				if (!registry.isLiveBinding(uri, session)) {
					// The bound workbook closed between resolve and our turn in the queue (same fault as a
					// persisted tombstone -- raise the same typed error so the run aborts identically).
					throw new NotebookWorkbookClosedError();
				}
				return manager.executeCell(session, code);
			});
			const status = formatOpStatus(result);
			const items = [vscode.NotebookCellOutputItem.text(status, 'text/plain')];
			await exec.replaceOutput(new vscode.NotebookCellOutput(items));
			// A G3 refusal means the code ran but the host declined to clobber a user formula -- the cell
			// succeeded (Python executed) but the refusal is shown; not an execution failure.
			exec.end(true, Date.now());
			return false;
		} catch (e) {
			const err = e instanceof Error ? e : new Error(String(e));
			const items: vscode.NotebookCellOutputItem[] = [];
			// Codex MED: a publish-then-raise cell already mutated the grid -- surface that status BEFORE
			// the error so the cell never hides a grid change behind only a Python traceback.
			const partial = partialStatusFromError(e);
			if (partial !== undefined) {
				items.push(vscode.NotebookCellOutputItem.text(formatOpStatus(partial), 'text/plain'));
			}
			items.push(vscode.NotebookCellOutputItem.error(err));
			await exec.replaceOutput(new vscode.NotebookCellOutput(items));
			exec.end(false, Date.now());
			return err instanceof NotebookWorkbookClosedError;
		}
	}

	// Lifetime (Codex HIGH-1): a bound Session closes when its last grid panel disposes -> detach the
	// notebook so the next cell fails loud rather than executing against a dead Session.
	context.subscriptions.push(
		CellGridPanel.onSessionClosing((session) => {
			registry.invalidateSession(session);
		}),
	);
	// A closed notebook forgets its binding (and any tombstone) so a reopen of the same uri starts clean.
	context.subscriptions.push(
		vscode.workspace.onDidCloseNotebookDocument((doc) => {
			registry.invalidateNotebook(doc.uri.toString());
		}),
	);
	// Make this controller the preferred kernel for our notebook type so the user (and the headless test)
	// does not face a kernel picker. Applied to already-open notebooks + ones opened later.
	const markPreferred = (doc: vscode.NotebookDocument): void => {
		if (doc.notebookType === QNB_NOTEBOOK_TYPE) {
			controller.updateNotebookAffinity(doc, vscode.NotebookControllerAffinity.Preferred);
		}
	};
	for (const doc of vscode.workspace.notebookDocuments) {
		markPreferred(doc);
	}
	context.subscriptions.push(vscode.workspace.onDidOpenNotebookDocument(markPreferred));

	// N-2a: open a reactive notebook bound to the focused grid, pre-seeded with a runnable publish template.
	// Eager-binds (registry.bindNotebook) so the FIRST cell run targets this grid regardless of later focus
	// changes -- the operator never has to keep the grid focused to run a cell.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookOpenReactiveNotebook', async () => {
			// All failure paths surface a clean message (No-Fallbacks system boundary -- a command error is
			// user-facing, the underlying error is shown, never swallowed). Without this an unexpected throw
			// (e.g. session.snapshot() on a broken grid) becomes a cryptic "command rejected" notification.
			try {
				const target = await pickTargetGrid();
				if (target === undefined) {
					return;
				}
				const sheetName = activeSheetName(target.session, target.sheet);
				const data = new vscode.NotebookData(seedNotebookCells(sheetName));
				const notebook = await vscode.workspace.openNotebookDocument(QNB_NOTEBOOK_TYPE, data);
				// TOCTOU (megaudit HIGH): the grid may have CLOSED during the awaits above. Re-validate the
				// chosen Session is still a live panel immediately before binding -- NO await between here and
				// bindNotebook -- else we would clear the tombstone and store a dead Session that
				// resolveForExecute hands out as "live".
				if (!isLiveGridSession(target.session)) {
					void vscode.window.showErrorMessage('Quantbook: the target Cell Grid closed before the notebook could be bound. Open a grid, then run "Quantbook: Bind Reactive Notebook to Grid".');
					return;
				}
				registry.bindNotebook(notebook.uri.toString(), target.session);
				controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
				await vscode.window.showNotebookDocument(notebook, { viewColumn: vscode.ViewColumn.Beside });
				void vscode.window.showInformationMessage('Quantbook: reactive notebook opened and bound to the grid. Run the cell to publish a variable.');
			} catch (e) {
				void vscode.window.showErrorMessage(`Quantbook: could not open the reactive notebook: ${e instanceof Error ? e.message : String(e)}`);
			}
		}),
	);

	// N-2b: rebind the active reactive notebook to the focused grid. This is the sanctioned recovery from a
	// closed-workbook tombstone (Codex HIGH-1 keeps the implicit path tombstoned) -- no close+reopen needed.
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookBindReactiveNotebook', async () => {
			try {
				const editor = vscode.window.activeNotebookEditor;
				if (editor === undefined || editor.notebook.notebookType !== QNB_NOTEBOOK_TYPE) {
					void vscode.window.showInformationMessage('Open a reactive notebook (.qnb), keep it focused, then run this command (you will be prompted to pick the grid).');
					return;
				}
				const target = await pickTargetGrid();
				if (target === undefined) {
					return;
				}
				// TOCTOU (megaudit HIGH): the chosen grid may have closed during the pick -- re-validate before
				// binding (no await between here and bindNotebook) so we never bind a dead Session.
				if (!isLiveGridSession(target.session)) {
					void vscode.window.showErrorMessage('Quantbook: the chosen Cell Grid is no longer open. Open a grid and try again.');
					return;
				}
				registry.bindNotebook(editor.notebook.uri.toString(), target.session);
				void vscode.window.showInformationMessage('Quantbook: this reactive notebook is now bound to the chosen grid.');
			} catch (e) {
				void vscode.window.showErrorMessage(`Quantbook: could not bind the reactive notebook: ${e instanceof Error ? e.message : String(e)}`);
			}
		}),
	);

	// N-2 "Bind Variable to Selected Cell": BIND the active reactive notebook to the focused grid AND append
	// a reactive `qb.publish(var, var, "Sheet!A1")` cell, with the A1 target computed from the focused grid's
	// SELECTION (W-G-2b, CellGridPanel.focusedGridSelection) so the operator never hand-types the ref. The
	// command writes notebook TEXT only -- the actual grid write still flows through the single live
	// `qb.publish -> publishDataset` path when the operator runs the cell (No second writer). It EAGER-BINDS
	// the notebook to the selection's grid (Codex HIGH): without that, an unbound notebook would bind on
	// first run to the then-focused grid, which may differ from the grid the target ref was built for (a
	// same-named sheet on another workbook -> wrong write). Eager-binding also clears a tombstone, so this is
	// the sanctioned recovery for a detached notebook (Codex MED). The target is the selection's full
	// rectangle (anchor+focus, normalized): a single-cell selection binds one cell (byte-identical to N-2);
	// a multi-cell selection binds a RANGE, so a 2D value (list-of-lists / numpy / DataFrame) publishes
	// across it (the runtime spreads + blank-fills the envelope -- no engine change here).
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookBindVariableToSelectedCell', async () => {
			try {
				const editor = vscode.window.activeNotebookEditor;
				if (editor === undefined || editor.notebook.notebookType !== QNB_NOTEBOOK_TYPE) {
					void vscode.window.showInformationMessage('Open a reactive notebook (.qnb), keep it focused, then run this command.');
					return;
				}
				// W-G-2b: the focused grid's selection persists even though the notebook is now the active editor
				// (it keys off CellGridPanel's focusedPanel, which notebook focus does not change).
				const sel = CellGridPanel.focusedGridSelection();
				if (sel === undefined) {
					void vscode.window.showInformationMessage('Select a cell in a Cell Grid first -- the binding targets the focused grid\'s selection.');
					return;
				}
				const uri = editor.notebook.uri.toString();
				// Fail-fast (good UX): refuse upfront if this notebook is DELIBERATELY bound to a DIFFERENT live
				// grid -- do not silently steal it (use "Bind Reactive Notebook to Grid" to rebind). `boundSession`
				// never returns a dead session (a closed session is deleted + tombstoned -> undefined), so a
				// non-undefined value here is a live grid. (Re-checked authoritatively after the input box below.)
				const boundBefore = registry.boundSession(uri);
				if (boundBefore !== undefined && boundBefore !== sel.session) {
					void vscode.window.showErrorMessage('Quantbook: this notebook is bound to a different Cell Grid. Rebind it ("Quantbook: Bind Reactive Notebook to Grid"), or select a cell in the bound grid, then try again.');
					return;
				}
				// Resolve the sheet NAME (the publish target is name-qualified). Throws loud if the sheet id is
				// gone -- focusedGridSelection() can return a valid-but-tombstoned sheet (Codex W-G-2b note).
				const sheetName = activeSheetName(sel.session, sel.sheet);
				// Codex MED: the kernel resolver splits a target on the FIRST `!`, so a sheet name containing `!`
				// (which the engine permits) would be mis-parsed. Refuse rather than append a mis-targeting cell.
				if (!isPublishableSheetName(sheetName)) {
					void vscode.window.showErrorMessage(`Quantbook: sheet name "${sheetName}" contains a "!", which the publish target syntax cannot express. Rename the sheet, then try again.`);
					return;
				}
				// Normalize the selection's two corners (anchor + focus, in any order) into a top-left ->
				// bottom-right rect; formatRangeTarget / buildBindPublishRangeCellSource assume start <= end.
				const rect = normalizeSelectionRect(sel.selection.anchorRow, sel.selection.anchorCol, sel.selection.focusRow, sel.selection.focusCol);
				const target = formatRangeTarget(sheetName, rect.startRow, rect.startCol, rect.endRow, rect.endCol);
				// No-Fallbacks (Codex LOW): validate + use the RAW input -- never trim-coerce (so " x" is rejected
				// in the box, not silently accepted as "x").
				const name = await vscode.window.showInputBox({
					prompt: `Variable to bind to ${target} (a Python name defined in this notebook)`,
					placeHolder: 'x',
					validateInput: (value) =>
						isValidPublishVariableName(value)
							? undefined
							: 'Enter a valid Python variable name (letters, digits, underscore; not starting with a digit; not a keyword; no spaces).',
				});
				if (name === undefined) {
					return; // operator dismissed the input box
				}
				// Authoritative TOCTOU re-check + EAGER-BIND, all synchronous (NO await between the live-check and
				// bindNotebook, so the check cannot itself race -- the isLiveGridSession discipline). Re-read the
				// binding too: it could have changed during the input-box await. Then bind THIS notebook to the
				// selection's grid so the appended target always resolves on the grid it was built for.
				const boundNow = registry.boundSession(uri);
				if (boundNow !== undefined && boundNow !== sel.session) {
					void vscode.window.showErrorMessage('Quantbook: this notebook is bound to a different Cell Grid. Rebind it ("Quantbook: Bind Reactive Notebook to Grid"), or select a cell in the bound grid, then try again.');
					return;
				}
				if (!isLiveGridSession(sel.session)) {
					void vscode.window.showErrorMessage('Quantbook: the target Cell Grid closed before the variable could be bound. Open a grid, select a cell, and try again.');
					return;
				}
				registry.bindNotebook(uri, sel.session);
				const source = buildBindPublishRangeCellSource(name, sheetName, rect.startRow, rect.startCol, rect.endRow, rect.endCol);
				const cell = new vscode.NotebookCellData(vscode.NotebookCellKind.Code, source, 'python');
				const edit = new vscode.WorkspaceEdit();
				const insertAt = editor.notebook.cellCount;
				edit.set(editor.notebook.uri, [vscode.NotebookEdit.insertCells(insertAt, [cell])]);
				const applied = await vscode.workspace.applyEdit(edit);
				if (!applied) {
					// No-Fallbacks: surface the failure rather than claim success on a no-op edit. (The notebook is
					// now correctly bound to the selected grid regardless -- harmless.)
					void vscode.window.showErrorMessage('Quantbook: bound the notebook, but could not append the binding cell. Try the command again.');
					return;
				}
				editor.revealRange(new vscode.NotebookRange(insertAt, insertAt + 1), vscode.NotebookEditorRevealType.Default);
				void vscode.window.showInformationMessage(`Quantbook: bound "${name}" to ${target}. Define ${name} above, then run the new cell to publish.`);
			} catch (e) {
				void vscode.window.showErrorMessage(`Quantbook: could not bind the variable: ${e instanceof Error ? e.message : String(e)}`);
			}
		}),
	);

	context.subscriptions.push(controller);
	return controller;
}
