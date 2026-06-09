/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// W3 B3 dependency-graph sidebar -- registers the "Dependencies" view under the quantbook Activity Bar.
//
// Kept SEPARATE from registerQuantbookShell (which owns the Activity Bar container, the Live-Python view,
// AND the `quantbook.hasOpenGrid` context key) so the W3 increment is additive: this module registers ONLY
// the new view + its provider, never touching the container or the context key. Called once from activate()
// AFTER registerQuantbookShell (so the gating context key is already driven) and AFTER the reactive-kernel
// manager exists (the sidebar's cross-language data source). Like the shell, everything is pushed onto
// `context.subscriptions` so a same-host re-activation does not leak a view/provider/listener.

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { ReactiveKernelManager } from '../reactiveKernel/reactiveKernelManager';
import type { SessionInstance } from '../types';
import { DepGraphTreeProvider } from './DepGraphTreeProvider';
import type { DepGraphNode } from './depGraphModel';

/** The view id of the Dependencies sidebar (matches `contributes.views` in package.json). */
const DEP_GRAPH_VIEW_ID = 'quantlab.depGraphView';

/**
 * Register the B3 dependency-graph "Dependencies" sidebar over the focused workbook's reactive kernel.
 * Idempotent per activation (all subscriptions are disposed on deactivate). The view is gated by the same
 * `quantbook.hasOpenGrid` context key as the Live-Python view (set in its package.json `when`), driven by
 * {@link registerQuantbookShell} -- this module does not re-drive it.
 *
 * @param reactiveKernelManager the per-session reactive-kernel registry -- the sidebar's cross-language data
 *   source (whether a kernel runs + which published variable drives the focused cell).
 */
export function registerDepGraphSidebar(
	context: vscode.ExtensionContext,
	reactiveKernelManager: ReactiveKernelManager<SessionInstance>,
): void {
	// The Dependencies sidebar refreshes on BOTH the grids-changed signal (focus/open/close AND the focused
	// SELECTION change -- all fire onDidChangeGrids) and the kernel-changed signal (a kernel started/stopped
	// or a publish frame landed -> a different reactive owner). The provider reads the focused cell + its
	// formula + its owner lazily in getChildren.
	const provider = new DepGraphTreeProvider(
		reactiveKernelManager,
		(listener) => CellGridPanel.onDidChangeGrids(listener),
		(listener) => reactiveKernelManager.onChange(listener),
	);
	const treeView = vscode.window.createTreeView<DepGraphNode>(DEP_GRAPH_VIEW_ID, { treeDataProvider: provider });
	context.subscriptions.push(treeView, provider);
}
