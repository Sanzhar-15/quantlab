/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-5 (W4 product shell) -- registers the Quantbook Activity Bar surface.
//
// First deliverable: the `quantlab-quantbook` Activity Bar container (contributed unconditionally in
// package.json -- a viewsContainer cannot carry a `when`) + the "Live Python" sidebar view, which is
// gated to a quantbook session via the `quantbook.hasOpenGrid` context key. This module owns:
//   - driving `quantbook.hasOpenGrid` off CellGridPanel.hasAnyPanel() (so the container's views appear
//     only when a Cell Grid is open -- the container itself is always present but empty otherwise);
//   - creating + registering the LivePythonTreeProvider over the focused workbook's reactive kernel.
//
// Called once from activate() AFTER the reactive-kernel manager exists (it is the sidebar's data source).

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { ReactiveKernelManager } from '../reactiveKernel/reactiveKernelManager';
import type { SessionInstance } from '../types';
import { LivePythonTreeProvider } from './LivePythonTreeProvider';
import type { LivePythonNode } from './livePythonModel';

/** The view id of the Live-Python sidebar (matches `contributes.views` in package.json). */
const LIVE_PYTHON_VIEW_ID = 'quantlab.livePythonView';
/** The context key gating the quantbook views; set true while any Cell Grid panel is open. */
const HAS_OPEN_GRID_CONTEXT = 'quantbook.hasOpenGrid';

/**
 * Register the Quantbook product shell: the Live-Python sidebar + the `quantbook.hasOpenGrid` context key
 * that gates the quantbook Activity Bar views. Idempotent per activation; everything is pushed onto
 * `context.subscriptions` so a same-host re-activation does not leak a view/provider/listener.
 *
 * @param reactiveKernelManager the per-session reactive-kernel registry -- the sidebar's live data source
 *   (kernel run-state + published variables for the focused workbook).
 */
export function registerQuantbookShell(
	context: vscode.ExtensionContext,
	reactiveKernelManager: ReactiveKernelManager<SessionInstance>,
): void {
	// Drive the gating context key off the live-panel set. Seed it now (a grid could already be open on a
	// same-host re-activation), then update on every grids-changed signal (open/close/focus). A boolean
	// context key cannot be partially set: hasAnyPanel() is the single source of truth.
	const updateHasOpenGrid = (): void => {
		void vscode.commands.executeCommand('setContext', HAS_OPEN_GRID_CONTEXT, CellGridPanel.hasAnyPanel());
	};
	updateHasOpenGrid();
	context.subscriptions.push(CellGridPanel.onDidChangeGrids(updateHasOpenGrid));

	// The Live-Python sidebar. It refreshes on BOTH the grids-changed signal (focus moved to a different
	// workbook -> different published set) AND the kernel-changed signal (a kernel started/stopped or a
	// publish frame landed). The provider reads the focused workbook + its kernel lazily in getChildren.
	const provider = new LivePythonTreeProvider(
		reactiveKernelManager,
		(listener) => CellGridPanel.onDidChangeGrids(listener),
		(listener) => reactiveKernelManager.onChange(listener),
	);
	const treeView = vscode.window.createTreeView<LivePythonNode>(LIVE_PYTHON_VIEW_ID, { treeDataProvider: provider });
	context.subscriptions.push(treeView, provider);
}
