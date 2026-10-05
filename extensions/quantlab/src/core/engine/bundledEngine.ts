/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * How a job's engine process is started: `<executable> -m <module>` in `cwd`.
 */
export interface EngineLaunch {
	/** The bundled engine executable, or a Python interpreter. */
	readonly executable: string;
	/** Which step of {@link selectEngine} chose `executable` ({@link ENGINE_SOURCES}); named in the job's first log line. */
	readonly source: string;
	/** The job's working directory; it exists. */
	readonly cwd: string;
	/** The engine source tree put on PYTHONPATH, or null for the bundled engine, which carries its own modules. */
	readonly engineRoot: string | null;
}

/**
 * The steps of {@link selectEngine}, each named differently, so the job's first log line says which one ran.
 */
export const ENGINE_SOURCES = {
	packaged: 'packaged bundled engine',
	setting: 'setting quantlab.pythonPath',
	development: 'development bundled engine',
} as const;

export type BundledEngineSource = typeof ENGINE_SOURCES.packaged | typeof ENGINE_SOURCES.development;

/**
 * The launch of the bundled engine: it runs in its own directory (a packaged app has no engine
 * source tree) and gets no PYTHONPATH.
 */
export function bundledEngineLaunch(executable: string, source: BundledEngineSource): EngineLaunch {
	return { executable, source, cwd: path.dirname(executable), engineRoot: null };
}

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

/** What decides which engine a backtest runs on. */
export interface EngineSelection {
	/** The quantlab extension's directory. */
	readonly extensionPath: string;
	/** The application root (`vscode.env.appRoot`): an extension inside it is the packaged app's built-in one. */
	readonly appRoot: string;
	readonly platform: NodeJS.Platform;
	/** `quantlab.pythonPath` as the user set it; empty when unset. */
	readonly explicitPython: string;
}

function isInside(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * The engine a backtest runs on. There is no implicit interpreter: no managed venv, no PATH probe.
 * - In the packaged app, only its bundled engine (`<extension>/engine/quantlab-engine/<exe>`); absent, a named error.
 * - In development, `quantlab.pythonPath` when the user set it (it must exist, and the engine source tree
 *   beside the extension must exist), else a bundled engine at a development location, else a named error.
 */
export function selectEngine(selection: EngineSelection): EngineLaunch {
	const { extensionPath, appRoot, platform, explicitPython } = selection;
	if (isInside(extensionPath, appRoot)) {
		const packaged = bundledEngineCandidates(extensionPath, platform)[1];
		if (!fs.statSync(packaged, { throwIfNoEntry: false })?.isFile()) {
			throw new Error(`[engine_missing] Quantlab: this app's bundled backtest engine is missing (${packaged}); reinstall the app.`);
		}
		return bundledEngineLaunch(packaged, ENGINE_SOURCES.packaged);
	}
	if (explicitPython !== '') {
		if (!fs.statSync(explicitPython, { throwIfNoEntry: false })?.isFile()) {
			throw new Error(`[engine_python_missing] Quantlab: quantlab.pythonPath is set to ${explicitPython}, which is not a file.`);
		}
		const engineRoot = path.resolve(extensionPath, '..', '..', 'engine');
		if (!fs.statSync(engineRoot, { throwIfNoEntry: false })?.isDirectory()) {
			throw new Error(`[engine_source_missing] Quantlab: quantlab.pythonPath is set, but the engine source tree ${engineRoot} does not exist.`);
		}
		return { executable: explicitPython, source: ENGINE_SOURCES.setting, cwd: engineRoot, engineRoot };
	}
	const bundled = resolveBundledEngine(extensionPath, platform);
	if (bundled === null) {
		throw new Error(`[engine_missing] Quantlab: no bundled backtest engine at ${bundledEngineCandidates(extensionPath, platform).join(', ')}, and quantlab.pythonPath is not set.`);
	}
	return bundledEngineLaunch(bundled, ENGINE_SOURCES.development);
}
