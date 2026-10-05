/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * CODEX-013: locations of the bundled (PyInstaller) engine executable, in resolution order.
 */
export function bundledEngineCandidates(extensionPath: string, platform: NodeJS.Platform): string[] {
	const exeName = platform === 'win32' ? 'quantlab-engine.exe' : 'quantlab-engine';
	return [
		// Relative to extension root (development layout)
		path.join(extensionPath, '..', '..', 'engine-dist', 'quantlab-engine', exeName),
		// Inside extension resources (packaged layout)
		path.join(extensionPath, 'engine', 'quantlab-engine', exeName),
		// Build output directory
		path.join(extensionPath, '..', '..', '.build', 'dist', 'quantlab-engine', exeName),
	];
}

/**
 * The first candidate that exists, or `null` when none does. A candidate that is absent
 * (ENOENT / ENOTDIR) is skipped; any other error (permissions, I/O) is not an absence and throws.
 */
export function resolveBundledEngine(extensionPath: string, platform: NodeJS.Platform): string | null {
	for (const candidate of bundledEngineCandidates(extensionPath, platform)) {
		try {
			fs.statSync(candidate);
			return candidate;
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'ENOTDIR') {
				continue;
			}
			throw new Error(`Quantlab: cannot inspect the bundled engine candidate ${candidate}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return null;
}
