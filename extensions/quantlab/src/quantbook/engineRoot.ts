/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';

/**
 * Where the Quantbook engine tree is (QL-QUANTBOOK). A packaged app carries it inside the extension
 * at `<extension root>/quantbook-engine` (build/quantbook/bundle.ts), shaped like the engine's own
 * tree: `target/release/<binding>`, `target/release/examples/<relay>`, `crates/quantbook-py/python`.
 * A development checkout has no such directory and uses the sibling engine worktree.
 */

export type EngineRootKind = 'packaged' | 'development';

export interface EngineRoot {
	readonly kind: EngineRootKind;
	readonly path: string;
}

export function packagedEngineRoot(extensionDir: string): string {
	return path.join(extensionDir, 'quantbook-engine');
}

export function developmentEngineRoot(extensionDir: string): string {
	// extensionDir is .../{IDE-root}/extensions/quantlab; three up is the directory holding the IDE
	// checkout and its sibling engine worktree `quantlab-quantbook`.
	return path.resolve(extensionDir, '..', '..', '..', 'quantlab-quantbook', 'quantbook-engine');
}

/**
 * The packaged tree when the extension carries one, otherwise the development tree. Only an absent
 * packaged directory (ENOENT / ENOTDIR) selects the development tree; any other error throws, and a
 * packaged path that is not a directory throws.
 */
export function resolveEngineRoot(extensionDir: string): EngineRoot {
	const packaged = packagedEngineRoot(extensionDir);
	let stat: fs.Stats;
	try {
		stat = fs.statSync(packaged);
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'ENOENT' || code === 'ENOTDIR') {
			return { kind: 'development', path: developmentEngineRoot(extensionDir) };
		}
		throw new Error(`[quantbook loader] cannot inspect the packaged engine directory ${packaged}: ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!stat.isDirectory()) {
		throw new Error(`[quantbook loader] the packaged engine path ${packaged} exists but is not a directory`);
	}
	return { kind: 'packaged', path: packaged };
}

/** The node binding's file name for `platform` (cargo's cdylib naming). */
export function bindingFileName(platform: NodeJS.Platform): string {
	switch (platform) {
		case 'darwin': return 'libql_bindings_node.dylib';
		case 'linux': return 'libql_bindings_node.so';
		case 'win32': return 'ql_bindings_node.dll';
		default: throw new Error(`Unsupported platform "${platform}" for ql-bindings-node. Supported: darwin, linux, win32.`);
	}
}

/**
 * Walk UP from `start` to the extension's own directory: the one whose `package.json` has
 * `name: "quantlab"` and whose path ends in `extensions/quantlab` (the IDE root and the engine
 * worktree share another package name, so the extension is the unambiguous anchor). Returns
 * `undefined` when no ancestor within 16 levels is that directory.
 *
 * An ancestor without a `package.json` (ENOENT / ENOTDIR) is skipped. A `package.json` that cannot
 * be read for any other reason, or that is not valid JSON, throws by name: it is never skipped.
 */
export function findExtensionDir(start: string): string | undefined {
	let cur = path.resolve(start);
	for (let depth = 0; depth < 16; depth += 1) {
		const pkgPath = path.join(cur, 'package.json');
		let raw: string | undefined;
		try {
			raw = fs.readFileSync(pkgPath, 'utf8');
		} catch (err: unknown) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code !== 'ENOENT' && code !== 'ENOTDIR') {
				throw new Error(`[quantbook loader] cannot read ${pkgPath} while locating the extension: ${err instanceof Error ? err.message : String(err)}`);
			}
		}
		if (raw !== undefined) {
			let pkg: { name?: unknown };
			try {
				pkg = JSON.parse(raw) as { name?: unknown };
			} catch (err: unknown) {
				throw new Error(`[quantbook loader] ${pkgPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
			}
			if (pkg !== null && typeof pkg === 'object' && pkg.name === 'quantlab' && cur.endsWith(path.join('extensions', 'quantlab'))) {
				return cur;
			}
		}
		const parent = path.dirname(cur);
		if (parent === cur) {
			return undefined;
		}
		cur = parent;
	}
	return undefined;
}
