/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5-1d-1 -- the VS Code shell that binds the reactive kernel to a CellGridPanel's Session.
//
// Thin glue over the vscode-free ReactiveKernelManager + ReactiveKernelClient. It:
//   - registers Start / Execute Cell / Stop commands (smoke-grade surface for the acid#1 operator
//     smoke; the full notebook UI is a later phase);
//   - resolves the FOCUSED Cell Grid's owning Session (focused-wins / ambiguous-abort, the FE-2-0
//     host-audit discipline) so the kernel always targets the workbook the operator means;
//   - builds clients bound to that exact SessionInstance (cursor unification: the panel render owns
//     the sole cursor; the client just publishDataset + recalcDirty + CellGridPanel.refreshSession);
//   - gates every spawn behind workspace trust (a reactive kernel runs arbitrary workspace Python);
//   - tears a Session's kernel down when its LAST panel closes (CellGridPanel.onSessionClosing).
//
// Errors are surfaced (No-Fallbacks) via a dedicated output channel + a toast -- NOT the
// cell_diagnostic channel (the panel only drains ENGINE events; there is no host-side injection API).

import * as vscode from 'vscode';

import { buildReactiveKernelEnv, resolveQuantlabPython, verifyPythonModules, verifyPythonVersion } from '../../qviz/pythonPath';
import { TrustManager } from '../../core/trust/TrustManager';
import { CellGridPanel } from '../cellGrid/cellGridPanel';
import { resolveCommandTargetPanel } from '../cellGrid/cellGridLogic';
import type { CellRangeJson, SessionInstance } from '../types';
import { ReactiveKernelClient } from './reactiveKernelClient';
import { ReactiveKernelManager } from './reactiveKernelManager';

// The EXACT import targets the supervisor + kernel bootstrap use at runtime (Codex 1d-2 MED-2: probe
// real imports/attrs, not just top-level specs). `ipykernel_launcher` is the `-m` kernel-launch target;
// `jupyter_client.kernelspec:KernelSpec` + `.manager:KernelManager` are the supervisor's imports
// (reactive_kernel_supervisor.py:43-44); `zmq` is pyzmq; `comm:create_comm` is the bootstrap's exact
// use (reactive_kernel_supervisor.py:60). Probed under the SCRUBBED spawn env so the check matches
// what the supervisor will see.
const REACTIVE_KERNEL_IMPORTS = [
	'ipykernel_launcher',
	'jupyter_client.kernelspec:KernelSpec',
	'jupyter_client.manager:KernelManager',
	'zmq',
	'comm:create_comm',
] as const;
const REACTIVE_KERNEL_PIP_HINT = 'ipykernel jupyter_client pyzmq comm';

/** Resolve the focused Cell Grid's owning Session, or show a hint + return undefined. */
function resolveReactiveTarget(): { session: SessionInstance; sheet: number } | undefined {
	const localPanels = CellGridPanel.activeLocalPanels();
	if (localPanels.length === 0) {
		void vscode.window.showInformationMessage('No Cell Grid panel is open. Run "Quantbook: Open Cell Grid" first.');
		return undefined;
	}
	const resolution = resolveCommandTargetPanel(localPanels, CellGridPanel.focusedLocalPanel());
	if (resolution.kind === 'ambiguous') {
		void vscode.window.showInformationMessage(
			'Multiple Cell Grids are open and none is focused. Click the Cell Grid you want, then re-run this command.',
		);
		return undefined;
	}
	return { session: resolution.session, sheet: resolution.sheet };
}

/** Trust gate (gate-first): a reactive kernel runs arbitrary workspace Python -- require BOTH VS Code
 *  Restricted-Mode trust AND QuantLab's own TrustManager grant for the workspace folder. */
function assertReactiveTrusted(): void {
	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder === undefined) {
		throw new Error('[kernel_untrusted_workspace] open a workspace folder and trust it to run a reactive kernel');
	}
	const uri = folder.uri.toString();
	if (!(vscode.workspace.isTrusted && TrustManager.getInstance().isWorkspaceTrusted(uri))) {
		throw new Error(
			'[kernel_untrusted_workspace] a reactive kernel runs arbitrary workspace Python -- trust the workspace to enable it',
		);
	}
}

function colLetters(letters: string): number {
	let col = 0;
	for (const ch of letters.toUpperCase()) {
		col = col * 26 + (ch.charCodeAt(0) - 64);
	}
	return col - 1;
}

function a1Cell(ref: string): { row: number; col: number } {
	const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
	if (m === null) {
		throw new Error(`[bad_target] malformed A1 cell: ${ref}`);
	}
	const row = parseInt(m[2], 10);
	if (row < 1) {
		throw new Error(`[bad_target] A1 row must be >= 1: ${ref}`);
	}
	return { row: row - 1, col: colLetters(m[1]) };
}

/** Resolve a sheet-qualified A1 target ("Sheet1!A1:C3") to a CellRangeJson on `session`'s sheets. */
function resolveA1OnSession(session: SessionInstance, a1: string): CellRangeJson {
	const bang = a1.indexOf('!');
	if (bang < 0) {
		throw new Error(`[bad_target] target must be sheet-qualified (e.g. Sheet1!A1): ${a1}`);
	}
	const name = a1.slice(0, bang);
	const ref = a1.slice(bang + 1);
	const sheet = session.snapshot().sheets.find((sh) => sh.name === name);
	if (sheet === undefined) {
		throw new Error(`[bad_target] unknown sheet "${name}" in target ${a1}`);
	}
	let a: { row: number; col: number };
	let b: { row: number; col: number };
	if (ref.includes(':')) {
		// MED (Codex fold): split WITHOUT a limit and require exactly two endpoints, so a malformed
		// range like "A1:B2:C3" fails loud instead of being silently truncated to "A1:B2".
		const parts = ref.split(':');
		if (parts.length !== 2) {
			throw new Error(`[bad_target] malformed range (expected exactly one ':'): ${a1}`);
		}
		a = a1Cell(parts[0]);
		b = a1Cell(parts[1]);
	} else {
		a = a1Cell(ref);
		b = a;
	}
	return { sheet: sheet.id, startRow: a.row, startCol: a.col, endRow: b.row, endCol: b.col };
}

/** Build the client factory: each session gets a client bound to it, with the interpreter resolved
 *  + version-checked at spawn time (fail-loud, No-Fallbacks). `onPublishedCellsChanged` is pumped to
 *  the manager (FE-5) so the Live-Python sidebar refreshes when a publish frame lands/retracts. */
function makeClientFactory(
	context: vscode.ExtensionContext,
	output: vscode.OutputChannel,
	onPublishedCellsChanged: () => void,
): (session: SessionInstance) => ReactiveKernelClient {
	const supervisorScript = vscode.Uri.joinPath(
		context.extensionUri,
		'python',
		'reactive_kernel',
		'reactive_kernel_supervisor.py',
	).fsPath;
	return (session: SessionInstance): ReactiveKernelClient => {
		const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
		const pythonExtConfig = vscode.workspace.getConfiguration('python');
		const resolved = resolveQuantlabPython({
			quantlabConfigPath: quantlabConfig.get<string>('pythonPath'),
			pythonExtConfigPath: pythonExtConfig.get<string>('defaultInterpreterPath'),
		});
		if (resolved === null) {
			throw new Error(
				'[kernel_no_python] no Python interpreter found (checked QUANTLAB_PYTHON, quantlab.pythonPath, '
				+ 'python.defaultInterpreterPath, ~/.quantlab/venv). Configure one to run a reactive kernel.',
			);
		}
		// FE-1.5-1d-2: build the hardened spawn env ONCE and use it for the version check, the dep
		// probe, AND the supervisor spawn -- so all three see exactly what the kernel will (the scrub
		// strips PYTHONPATH/PYTHONHOME + disables user site-packages; Codex MED-1: the version check
		// must not run with those vars live). On any miss, fail loud with one actionable install hint --
		// never fall through to a kernel that crashes at first import.
		const spawnEnv = buildReactiveKernelEnv();
		const versionCheck = verifyPythonVersion(resolved.pythonPath, 3, 10, spawnEnv);
		if (!versionCheck.ok) {
			throw new Error(`[kernel_bad_python] ${resolved.pythonPath} is not usable: ${versionCheck.error}`);
		}
		const depCheck = verifyPythonModules(resolved.pythonPath, REACTIVE_KERNEL_IMPORTS, spawnEnv);
		if (!depCheck.ok) {
			const why = depCheck.error !== undefined ? ` (${depCheck.error})` : '';
			throw new Error(
				`[kernel_missing_deps] ${resolved.pythonPath} is missing required modules: ${depCheck.missing.join(', ')}${why}. `
				+ `Install them into that interpreter: "${resolved.pythonPath}" -m pip install ${REACTIVE_KERNEL_PIP_HINT}`,
			);
		}
		return new ReactiveKernelClient({
			pythonPath: resolved.pythonPath,
			supervisorScript,
			env: spawnEnv,
			session,
			resolveTarget: (a1: string): CellRangeJson => resolveA1OnSession(session, a1),
			onChanged: (): void => {
				const { failed } = CellGridPanel.refreshSession(session);
				if (failed > 0) {
					void vscode.window.showWarningMessage(
						`Quantbook reactive: ${failed} panel(s) failed to re-render -- see the Quantbook Reactive Kernel output.`,
					);
				}
				// FE-5: a publish frame landed/retracted -> the published-variable set may have changed;
				// refresh the Live-Python sidebar. (refreshSession above repaints the grid badges; this
				// pumps the sidebar, which reads the kernel's published cells.)
				onPublishedCellsChanged();
			},
			onError: (message: string): void => {
				output.appendLine(message);
				void vscode.window.showWarningMessage(`Quantbook reactive kernel: ${message}`);
			},
		});
	};
}

/**
 * Register the reactive-kernel commands and return the manager so `deactivate` can await its
 * disposal (no orphaned ipykernel). Call once from `activate` AFTER the engine + trust are ready.
 */
export function registerReactiveKernelCommands(
	context: vscode.ExtensionContext,
	isTrustReady: () => boolean,
): ReactiveKernelManager<SessionInstance> {
	const output = vscode.window.createOutputChannel('Quantbook Reactive Kernel');
	context.subscriptions.push(output);

	// HIGH (Codex fold): the trust subsystem must have INITIALIZED for the gate to be meaningful (a
	// partial/failed TrustManager.initialize could otherwise leave a map the gate would trust). Refuse
	// gate-first if init did not succeed -- fail-closed.
	const gate = (): void => {
		if (!isTrustReady()) {
			throw new Error('[kernel_untrusted_workspace] the workspace-trust subsystem failed to initialize; refusing to spawn');
		}
		assertReactiveTrusted();
	};
	// FE-5: the factory's per-session `onChanged` pumps the manager's change event so the Live-Python
	// sidebar refreshes on a publish frame. The manager does not exist yet when the factory is built
	// (the factory is a constructor arg), so route through a mutable holder whose field is set right after
	// construction. The factory closure only RUNS lazily when a session starts -- always after assignment;
	// the `?.` guard keeps the (unreachable) pre-assignment call a no-op rather than a TDZ throw.
	const managerHolder: { manager?: ReactiveKernelManager<SessionInstance> } = {};
	const manager = new ReactiveKernelManager<SessionInstance>(
		gate,
		makeClientFactory(context, output, () => managerHolder.manager?.notifyChanged()),
		// W-G: when a session's kernel is stopped or lost, its published-cells store is gone -- refresh the
		// still-open panels so their bound-cell badges clear (the provider now returns []). Mirrors the
		// onChanged refresh path; refreshSession is a no-op for a session whose panels have all closed.
		(session) => {
			CellGridPanel.refreshSession(session);
		},
	);
	managerHolder.manager = manager;

	// W-G bound-cell indicator: let every CellGridPanel pull the cells its session's published variables
	// drive (keeps the panel decoupled from the manager -- it knows only this provider signature, default
	// none). Cleared on deactivate so a same-host re-activation does not leave a stale captured manager.
	CellGridPanel.setPublishedCellsProvider((session, sheet) => manager.publishedCellsForSheet(session, sheet));
	context.subscriptions.push({ dispose: () => CellGridPanel.setPublishedCellsProvider(undefined) });

	// Tear a Session's kernel down when its LAST Cell Grid panel closes (before session.close()).
	// The disposable is pushed so a same-host re-activation does not leak a stale listener (LOW fold).
	context.subscriptions.push(
		CellGridPanel.onSessionClosing((session) => {
			void manager.disposeSession(session);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookReactiveStart', async () => {
			const target = resolveReactiveTarget();
			if (target === undefined) {
				return;
			}
			// LOW (Codex fold): give the operator a QuantLab-trust GRANT path (no trust command is
			// contributed otherwise). VS Code Restricted Mode is the user's to lift; here we only prompt
			// for QuantLab's own workspace-trust grant. The manager's gate re-checks + refuses if declined.
			const folder = vscode.workspace.workspaceFolders?.[0];
			if (folder !== undefined && vscode.workspace.isTrusted && !TrustManager.getInstance().isWorkspaceTrusted(folder.uri.toString())) {
				await TrustManager.getInstance().promptWorkspaceTrust(folder.uri.toString());
			}
			try {
				await manager.start(target.session);
				output.appendLine('reactive kernel started for the focused workbook');
				void vscode.window.showInformationMessage('Quantbook: reactive kernel started. Run "Reactive Cell" to publish a variable.');
			} catch (e) {
				const m = e instanceof Error ? e.message : String(e);
				output.appendLine(`start failed: ${m}`);
				void vscode.window.showErrorMessage(`Quantbook: reactive kernel start failed: ${m}`);
			}
		}),
		vscode.commands.registerCommand('quantlab.quantbookReactiveExecuteCell', async () => {
			const target = resolveReactiveTarget();
			if (target === undefined) {
				return;
			}
			const code = await vscode.window.showInputBox({
				prompt: 'Reactive cell (Python) -- e.g. x = 7  or  qb.publish("x", x, "Sheet1!B1", owner_cell_id="c1")',
				placeHolder: 'x = 7',
			});
			if (code === undefined || code.trim() === '') {
				return;
			}
			try {
				await manager.executeCell(target.session, code);
			} catch (e) {
				const m = e instanceof Error ? e.message : String(e);
				output.appendLine(`cell error: ${m}`);
				void vscode.window.showWarningMessage(`Quantbook reactive cell error: ${m}`);
			}
		}),
		// Programmatic (non-interactive) twin of "Reactive Cell": takes the code as an ARGUMENT,
		// RETURNS the ReactiveOpResult, and RETHROWS failures (no swallowing). This is the headless
		// automation seam (the W-T acid#1 integration test drives it via executeCommand(id, code)) --
		// the interactive command above keeps the showInputBox + toast UX for humans. No-Fallbacks:
		// a missing target or empty code is a programmer error and throws loudly, never silent.
		vscode.commands.registerCommand('quantlab.quantbookExecuteReactiveCode', async (codeArg?: string) => {
			const target = resolveReactiveTarget();
			if (target === undefined) {
				throw new Error('[no_cell_grid] no Cell Grid panel to target; open one before executing reactive code');
			}
			if (typeof codeArg !== 'string' || codeArg.trim() === '') {
				throw new Error('[empty_code] quantbookExecuteReactiveCode requires a non-empty code string argument');
			}
			return manager.executeCell(target.session, codeArg);
		}),
		vscode.commands.registerCommand('quantlab.quantbookReactiveStop', async () => {
			const target = resolveReactiveTarget();
			if (target === undefined) {
				return;
			}
			await manager.disposeSession(target.session);
			output.appendLine('reactive kernel stopped');
			void vscode.window.showInformationMessage('Quantbook: reactive kernel stopped.');
		}),
	);

	return manager;
}
