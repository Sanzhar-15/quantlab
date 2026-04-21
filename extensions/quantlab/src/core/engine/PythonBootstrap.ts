/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';
import * as vscode from 'vscode';

const execFileAsync = promisify(execFile);

const VENV_DIR = path.join(os.homedir(), '.quantlab', 'venv');
const VENV_PYTHON = process.platform === 'win32'
	? path.join(VENV_DIR, 'Scripts', 'python.exe')
	: path.join(VENV_DIR, 'bin', 'python');

const PIP_TIMEOUT_MS = 300_000; // 5 minutes for large dependency installs
const IMPORT_CHECK = 'import pandas; import numpy; import quantlab';

let managedPythonPath: string | undefined;

function findBasePythonCandidates(): string[] {
	return process.platform === 'win32'
		? ['python', 'python3']
		: ['python3', 'python'];
}

async function findBasePython(): Promise<string | undefined> {
	for (const candidate of findBasePythonCandidates()) {
		try {
			const { stdout } = await execFileAsync(
				candidate,
				['-c', 'import sys; print(sys.version_info.major)'],
				{ timeout: 10_000 }
			);
			if (stdout.trim() === '3') {
				return candidate;
			}
		} catch {
			// candidate not found or not Python 3
		}
	}
	return undefined;
}

async function verifyDependencies(pythonPath: string): Promise<boolean> {
	try {
		await execFileAsync(pythonPath, ['-c', IMPORT_CHECK], { timeout: 15_000 });
		return true;
	} catch {
		return false;
	}
}

export namespace PythonBootstrap {

	export function getManagedPythonPath(): string | undefined {
		return managedPythonPath;
	}

	export async function ensureDependencies(engineRoot: string): Promise<void> {
		// Fast path: venv exists and deps are satisfied
		if (fs.existsSync(VENV_PYTHON)) {
			const ok = await verifyDependencies(VENV_PYTHON);
			if (ok) {
				managedPythonPath = VENV_PYTHON;
				return;
			}
		}

		// Need to create or repair the venv
		const basePython = await findBasePython();
		if (!basePython) {
			void vscode.window.showErrorMessage(
				'Quantlab: Python 3 not found on your system. ' +
				'Install Python 3.11+ and reload the window.'
			);
			return;
		}

		try {
			await vscode.window.withProgress(
				{
					location: vscode.ProgressLocation.Notification,
					title: 'Quantlab: Installing Python dependencies…',
					cancellable: false,
				},
				async (progress) => {
					// 1. Ensure parent directory exists
					progress.report({ message: 'Creating virtual environment…' });
					await fs.promises.mkdir(path.join(os.homedir(), '.quantlab'), { recursive: true });

					// 2. Create venv (or recreate if broken)
					await execFileAsync(basePython, ['-m', 'venv', VENV_DIR], {
						timeout: 60_000,
					});

					// 3. Install engine package (editable) with all deps
					progress.report({ message: 'Installing packages (this may take a moment)…' });
					const pip = process.platform === 'win32'
						? path.join(VENV_DIR, 'Scripts', 'pip')
						: path.join(VENV_DIR, 'bin', 'pip');

					await execFileAsync(pip, ['install', '-e', engineRoot], {
						timeout: PIP_TIMEOUT_MS,
					});

					// 4. Verify
					progress.report({ message: 'Verifying installation…' });
					const ok = await verifyDependencies(VENV_PYTHON);
					if (!ok) {
						throw new Error('Dependency verification failed after install');
					}

					managedPythonPath = VENV_PYTHON;
				}
			);
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			void vscode.window.showErrorMessage(
				`Quantlab: Failed to install Python dependencies. ${msg}`
			);
			managedPythonPath = undefined;
		}
	}
}
