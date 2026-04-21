/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';

let _childProcess: any = null;
async function getChildProcess(): Promise<any> {
	if (!_childProcess) {
		try {
			// @ts-ignore
			_childProcess = await import('child_process');
		} catch {
			throw new Error('child_process not available in browser context');
		}
	}
	return _childProcess;
}
import { QicError } from '../canonical/types.js';

const REQUIRED_PACKAGES = ['numpy', 'pandas', 'pyarrow'];

/**
 * Python environment discovery and validation.
 *
 * AUDIT FIX VIII-PC1 (HIGH): Discovery chain: setting → .venv → python3 → python.
 * Validates via import check for required packages.
 */
export class PythonEnvironmentManager {

	private cachedPythonPath: string | null = null;

	constructor(
		private readonly workspaceRoot: string,
		private readonly getPythonPathSetting: () => string | undefined,
	) {}

	/**
	 * Discover a suitable Python environment.
	 * Discovery chain: setting → .venv → python3 → python
	 */
	async discoverPython(): Promise<string> {
		if (this.cachedPythonPath) {
			return this.cachedPythonPath;
		}

		for (const candidate of this.candidates()) {
			if (await this.validate(candidate)) {
				this.cachedPythonPath = candidate;
				return candidate;
			}
		}

		throw new QicError('QIC-Q001', 'No suitable Python environment found. Required packages: ' + REQUIRED_PACKAGES.join(', '));
	}

	/**
	 * Validate a Python environment by running import checks.
	 */
	async validate(pythonPath: string): Promise<boolean> {
		try {
			const importCheck = REQUIRED_PACKAGES.map(p => `import ${p}`).join('; ') + '; print("ok")';
			const result = await this.execPython(pythonPath, ['-c', importCheck]);
			return result.trim() === 'ok';
		} catch {
			return false;
		}
	}

	/**
	 * Check if a Python binary exists and is executable.
	 */
	async exists(pythonPath: string): Promise<boolean> {
		try {
			const result = await this.execPython(pythonPath, ['--version']);
			return result.startsWith('Python');
		} catch {
			return false;
		}
	}

	/**
	 * Get Python version string.
	 */
	async getVersion(pythonPath?: string): Promise<string> {
		const resolved = pythonPath ?? await this.discoverPython();
		const result = await this.execPython(resolved, ['--version']);
		return result.trim();
	}

	/**
	 * Clear cached Python path (e.g., after settings change).
	 */
	clearCache(): void {
		this.cachedPythonPath = null;
	}

	private *candidates(): Generator<string> {
		// 1. User setting
		const settingPath = this.getPythonPathSetting();
		if (settingPath) {
			yield settingPath;
		}

		// 2. Workspace .venv
		yield path.join(this.workspaceRoot, '.venv', 'bin', 'python');
		yield path.join(this.workspaceRoot, '.venv', 'Scripts', 'python.exe'); // Windows

		// 3. System python3
		yield 'python3';

		// 4. System python
		yield 'python';
	}

	private async execPython(pythonPath: string, args: string[]): Promise<string> {
		const cp = await getChildProcess();
		return new Promise((resolve, reject) => {
			cp.execFile(pythonPath, args, { timeout: 10_000 }, (error: any, stdout: string, stderr: string) => {
				if (error) {
					reject(error);
				} else {
					resolve(stdout || stderr);
				}
			});
		});
	}
}
