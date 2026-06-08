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
		// LOW (Codex fold): clicking the notebook Run button blurs the grid, so "click the grid then
		// re-run" can loop back to ambiguous. Until N-2 adds an explicit bind command, the honest
		// recovery is to leave exactly one grid open.
		throw new Error(
			'[ambiguous_cell_grid] multiple Cell Grids are open; this notebook cannot tell which to bind to. '
			+ 'Close all but the target grid (an explicit bind command comes in a later version), then run the cell again',
		);
	}
	return resolution.session;
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

	context.subscriptions.push(controller);
	return controller;
}
