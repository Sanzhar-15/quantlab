/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- ql-bindings-node loader.
 *
 * Locates and loads the engine's compiled cdylib (`.dylib` on macOS,
 * `.so` on Linux, `.dll` on Windows). Resolves via the environment
 * variable `QUANTBOOK_ENGINE_PATH` first; falls back to the workspace-
 * relative dev path otherwise. **Per CLAUDE.md no-fallback rule**:
 * "fallback" here is a path-resolution alternative, not an error-
 * masking behavior. If both resolutions fail OR the file isn't loadable,
 * we throw LOUDLY with a precise diagnostic.
 *
 * V1 dev-path resolution:
 *   quantlab-quantbook/quantbook-engine/target/release/libql_bindings_node.<ext>
 * computed relative to the IDE workspace root (the parent of
 * `quantlab/` which is the IDE-fork repo).
 *
 * V2 publish pipeline (deferred):
 *   Use `@napi-rs/cli` or a custom artifact pipeline to ship the .node
 *   file as part of the extension package. V1's dev-path approach
 *   requires both engine + IDE repos checked out side-by-side at
 *   ~/Documents/Sanzhar/Sanzhar/quantlab/.
 */

import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

import type { QuantbookNativeModule } from './types';

let cachedModule: QuantbookNativeModule | undefined;

/**
 * Resolve the absolute path to the cdylib for the current platform.
 * Returns the absolute path (regardless of whether the file exists);
 * existence is checked in {@link loadQuantbookEngine}.
 *
 * Resolution order:
 * 1. `QUANTBOOK_ENGINE_PATH` env var, if set + non-empty.
 * 2. V1 dev-path discovery: walk UP from `__dirname` until we find
 *    the IDE repo root (identified by `package.json` with
 *    `name: "code-oss-dev"`), then `..` to the parent workspace dir,
 *    then descend to `quantlab-quantbook/quantbook-engine/target/release`.
 *
 * The IDE-repo-root anchor is independent of whether `__dirname` is
 * the un-compiled `src/quantbook` or the compiled `out/src/quantbook`
 * (differs by one segment, broke the original hard-coded `..` count).
 */
export function resolveEnginePath(): string {
	const env = process.env.QUANTBOOK_ENGINE_PATH;
	if (typeof env === 'string' && env.length > 0) {
		return path.resolve(env);
	}
	const ext = nativeLibExt();
	const ideRepoRoot = findIdeRepoRoot(__dirname);
	if (ideRepoRoot === undefined) {
		// Fall through to a coarse path with __dirname so the existence
		// check in loadQuantbookEngine surfaces a useful diagnostic
		// (the error message will include this path).
		return path.resolve(
			__dirname,
			'..', '..', '..', '..', '..', '..',
			'quantlab-quantbook', 'quantbook-engine', 'target', 'release',
			`libql_bindings_node.${ext}`,
		);
	}
	return path.resolve(
		ideRepoRoot,
		'..', 'quantlab-quantbook', 'quantbook-engine', 'target', 'release',
		`libql_bindings_node.${ext}`,
	);
}

/**
 * Walk UP from `start` looking for the IDE repo's `package.json`
 * (identified by `name: "code-oss-dev"`). Returns the absolute path
 * to the directory containing that package.json, or `undefined` if
 * not found within the filesystem-root traversal limit.
 */
function findIdeRepoRoot(start: string): string | undefined {
	let cur = path.resolve(start);
	for (let depth = 0; depth < 16; depth += 1) {
		const pkgPath = path.join(cur, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const raw = fs.readFileSync(pkgPath, 'utf8');
				const pkg = JSON.parse(raw) as { name?: string };
				if (pkg.name === 'code-oss-dev') {
					return cur;
				}
			} catch {
				// Malformed package.json or read failure -- keep walking.
				// We're scanning ancestors; don't surface a partial read.
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

function nativeLibExt(): string {
	switch (process.platform) {
		case 'darwin': return 'dylib';
		case 'linux': return 'so';
		case 'win32': return 'dll';
		default:
			throw new Error(
				`Unsupported platform "${process.platform}" for ql-bindings-node V1. ` +
				`Supported: darwin, linux, win32.`,
			);
	}
}

/**
 * Load and return the engine native module. Cached after first load.
 *
 * **Failure modes (all surface LOUDLY)**:
 * - `QUANTBOOK_ENGINE_PATH` set but file doesn't exist
 * - Default dev-path doesn't exist (engine not built, or wrong
 *   workspace layout)
 * - File exists but `require()` throws (binary built for wrong
 *   platform, wrong Node ABI, missing symbols, etc.)
 *
 * Each failure mode emits a distinct diagnostic so the user knows
 * what to fix.
 *
 * **Why .dylib / .so / .dll not .node**: V1 loads the raw cdylib
 * directly. Node.js's `process.dlopen` accepts any extension at the
 * native level; the `.node` extension is just a convention from
 * `@napi-rs/cli`. V2 publish pipeline will produce `.node` files.
 */
export function loadQuantbookEngine(): QuantbookNativeModule {
	if (cachedModule !== undefined) {
		return cachedModule;
	}
	const enginePath = resolveEnginePath();
	if (!fs.existsSync(enginePath)) {
		throw new Error(
			`Quantbook engine binary not found at ${enginePath}. ` +
			`Either set QUANTBOOK_ENGINE_PATH or build the engine with: ` +
			`cd ../quantlab-quantbook/quantbook-engine && cargo build -p ql-bindings-node --release`,
		);
	}
	// process.dlopen does the actual loading. Build a fake CommonJS
	// module first so dlopen has somewhere to attach exports.
	// `as unknown as NodeJS.Module` is the documented Node.js pattern
	// for non-.node files (the `unknown` step makes the cast explicit
	// rather than dangerous). V2 publish pipeline will switch to
	// `require()` + `.node` extension which eliminates the cast.
	const fakeModule: { exports: Record<string, unknown> } = { exports: {} };
	try {
		process.dlopen(fakeModule as unknown as NodeJS.Module, enginePath);
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Failed to dlopen Quantbook engine at ${enginePath}: ${detail}. ` +
			`Check that the binary matches your platform (got platform=${process.platform}, arch=${process.arch}) ` +
			`and Node ABI (got Node ${process.version}).`,
		);
	}
	cachedModule = fakeModule.exports as unknown as QuantbookNativeModule;
	// Smoke-check the expected surface is present. Don't silently
	// accept a load that returned an empty / partial export set.
	if (typeof cachedModule.version !== 'function' || typeof cachedModule.CollabSession !== 'function') {
		throw new Error(
			`Quantbook engine at ${enginePath} loaded but is missing expected exports. ` +
			`Got: ${JSON.stringify(Object.keys(cachedModule))}. ` +
			`Expected at least: version(), CollabSession constructor.`,
		);
	}
	return cachedModule;
}

/**
 * Test helper -- reset the module cache so unit tests can re-load.
 * Production code should not call this.
 *
 * @internal
 */
export function _resetQuantbookEngineCacheForTests(): void {
	cachedModule = undefined;
}

/**
 * Return host info string for diagnostics. Not load-bearing; used in
 * status displays + error messages.
 */
export function quantbookHostInfo(): string {
	return [
		`node=${process.version}`,
		`platform=${process.platform}`,
		`arch=${process.arch}`,
		`uptime=${process.uptime().toFixed(1)}s`,
		`tmpdir=${os.tmpdir()}`,
	].join(' ');
}
