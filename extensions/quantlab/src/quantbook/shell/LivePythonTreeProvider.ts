/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-5 (W4 product shell) -- the "Live Python" sidebar TreeDataProvider.
//
// Mirrors the DataTreeProvider/DataPanelProvider pattern (panels/data/). It renders the node model from
// the vscode-free {@link buildLivePythonNodes}: it reads the FOCUSED Cell Grid's owning Session, asks the
// reactive-kernel layer whether a kernel is running + what it publishes, formats those into nodes, and
// adapts each to a TreeItem. All vscode coupling lives here; the model + A1 formatting are pure + tested.
//
// Refresh signal: the provider is given two pull events at construction -- a CellGrid "grids changed"
// event (focus/open/close) and a reactive-kernel "kernel/published-cells changed" event. On either, it
// fires onDidChangeTreeData and re-reads the focused workbook. No polling, no fabricated data.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { SessionInstance } from '../types';
import type { PublishedRange } from '../reactiveKernel/publishedCellsStore';
import { assemblePublishedVariables, buildLivePythonNodes, focusedWorkbookLabel, type LivePythonInput, type LivePythonNode } from './livePythonModel';

/**
 * The read-only kernel surface the sidebar consults for the focused session. The {@link ReactiveKernelManager}
 * implements both methods directly; injecting this narrow interface keeps the provider decoupled from the
 * manager's full lifecycle API (and makes a fake trivial were the provider ever unit-tested).
 */
export interface LivePythonKernelSource {
	/** Whether a live reactive kernel is currently registered for `session`. */
	hasKernel(session: SessionInstance): boolean;
	/** The cells each published variable drives on (`session`, `sheet`); `[]` when no kernel is registered. */
	publishedCellsForSheet(session: SessionInstance, sheet: number): PublishedRange[];
}

export class LivePythonTreeProvider implements vscode.TreeDataProvider<LivePythonNode> {
	private readonly _onDidChangeTreeData = new vscode.EventEmitter<LivePythonNode | void>();
	readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

	private disposed = false;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly kernels: LivePythonKernelSource,
		/** Fired when the live-grid landscape changes (open/close/focus) -- {@link CellGridPanel.onDidChangeGrids}. */
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

	getTreeItem(element: LivePythonNode): vscode.TreeItem {
		// A `variable` node has no `label` field (its tree label is the variable name); every other node
		// carries an explicit `label`. Compute the label per kind so the union access stays type-safe.
		const label = element.kind === 'variable' ? element.name : element.label;
		const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
		item.id = element.id;

		switch (element.kind) {
			case 'noGrid':
				item.iconPath = new vscode.ThemeIcon('info');
				item.contextValue = 'quantlab.livePython.noGrid';
				break;

			case 'kernelStatus':
				item.iconPath = new vscode.ThemeIcon(element.running ? 'debug-start' : 'debug-stop');
				item.description = element.workbookLabel;
				item.tooltip = element.running
					? `A reactive kernel is running for ${element.workbookLabel}.`
					: `No reactive kernel is running for ${element.workbookLabel}. Run "Quantbook: Start Reactive Kernel".`;
				item.contextValue = 'quantlab.livePython.kernelStatus';
				break;

			case 'emptyPublished':
				item.iconPath = new vscode.ThemeIcon('circle-slash');
				item.tooltip = 'The kernel is running but has not published any variables to the grid yet. '
					+ 'Run a reactive cell that calls qb.publish(...).';
				item.contextValue = 'quantlab.livePython.emptyPublished';
				break;

			case 'variable':
				item.iconPath = new vscode.ThemeIcon('symbol-variable');
				item.description = element.target;
				item.tooltip = `Reactive variable "${element.name}" drives ${element.target}.`;
				item.contextValue = 'quantlab.livePython.variable';
				break;
		}

		return item;
	}

	getChildren(element?: LivePythonNode): LivePythonNode[] {
		// Flat list (v1): only the root has children; every node is a leaf.
		if (element !== undefined) {
			return [];
		}
		return buildLivePythonNodes(this.computeInput());
	}

	// --- Focused-workbook model assembly ---

	/**
	 * Read the focused Cell Grid + its kernel into the pure model's input shape. A render failure here
	 * (e.g. a napi `listSheets()` throw on a faulted session) is surfaced LOUD per No-Fallbacks: the node
	 * model would otherwise have to invent a state. We let it propagate to VS Code's tree error surface
	 * rather than show a healthy-looking empty sidebar over a broken session.
	 */
	private computeInput(): LivePythonInput {
		const focused = CellGridPanel.focusedLocalPanel();
		if (focused === undefined) {
			return { focusedWorkbookLabel: undefined, kernelRunning: false, publishedVariables: [] };
		}

		const { session, sheet } = focused;
		const sheets = session.listSheets();
		// The status node labels the workbook by the focused sheet's name; an out-of-band sheet deletion is
		// surfaced explicitly (not masked) by focusedWorkbookLabel.
		const workbookLabel = focusedWorkbookLabel(sheets, sheet);

		const kernelRunning = this.kernels.hasKernel(session);
		if (!kernelRunning) {
			return { focusedWorkbookLabel: workbookLabel, kernelRunning: false, publishedVariables: [] };
		}

		// A published variable can drive cells on ANY sheet of the workbook -> enumerate every live sheet and
		// pair each published range with that sheet's own name for A1 formatting (no by-id map, no fallback).
		const publishedVariables = assemblePublishedVariables(
			sheets,
			(sheetId) => this.kernels.publishedCellsForSheet(session, sheetId),
		);

		return { focusedWorkbookLabel: workbookLabel, kernelRunning: true, publishedVariables };
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
