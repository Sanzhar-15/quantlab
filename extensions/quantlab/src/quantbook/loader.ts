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
 *    the extensions/quantlab/package.json anchor (identified by
 *    `name: "quantlab"`), then `..` twice to the IDE repo root, then
 *    `..` to the parent workspace dir, then descend to
 *    `quantlab-quantbook/quantbook-engine/target/release`.
 *
 * **V1 audit closure (Opus M2 + Codex M3, 2026-05-22)**: the prior
 * anchor was the IDE-root `package.json` with `name: "code-oss-dev"`.
 * Verified that the engine worktree (`quantlab-quantbook/`) is itself
 * a worktree of the IDE repo and SHARES the same `code-oss-dev`
 * package.json. That meant a user `cd`'d into the engine worktree
 * would walk up to the WRONG IDE-root (the engine worktree's own) and
 * resolve to `quantlab-quantbook/quantlab-quantbook/quantbook-engine/...`
 * which doesn't exist. The extensions/quantlab/package.json is
 * unique enough (named `"quantlab"` vs the root's `"code-oss-dev"`)
 * to avoid this collision. Both worktrees have `extensions/quantlab/`
 * with the same source, so we anchor THROUGH the extension to its
 * containing IDE repo root.
 *
 * **Phase 5.7 V1 megaudit closure (Codex MEDIUM, 2026-05-22)**: the
 * prior V1 implementation had a `console.warn`-then-fall-through
 * "coarse 6-hop path" branch when the extension anchor wasn't found.
 * Per CLAUDE.md no-fallback rule, this was a silent failure mode (a
 * stale .dylib in the 6-hop path would load successfully). Replaced
 * with an explicit `throw` directing the caller to set
 * `QUANTBOOK_ENGINE_PATH`. The only valid resolution paths are now
 * (1) explicit env var, (2) successful walk-up anchor discovery.
 */
export function resolveEnginePath(): string {
	const env = process.env.QUANTBOOK_ENGINE_PATH;
	if (typeof env === 'string' && env.length > 0) {
		return path.resolve(env);
	}
	const ext = nativeLibExt();
	const extensionDir = findExtensionDir(__dirname);
	if (extensionDir === undefined) {
		// **Phase 5.7 V1 megaudit closure (Codex MEDIUM, 2026-05-22):**
		// the prior V1 closure emitted a `console.warn` then fell
		// through to a coarse 6-hop relative path. Per CLAUDE.md
		// no-fallback rule, that's a silent failure mode -- if the
		// 6-hop path happened to contain a stale .dylib (e.g., from a
		// different engine checkout), the loader would happily load
		// it. Throw LOUDLY instead. The only legitimate way to reach
		// this branch is a non-canonical workspace layout, in which
		// case `QUANTBOOK_ENGINE_PATH` is the right escape hatch.
		throw new Error(
			'[quantbook loader] Could not locate the extensions/quantlab ' +
			`anchor by walking up from ${__dirname}. ` +
			'This indicates a non-canonical workspace layout (the engine ' +
			'expects the extension to be at .../quantlab/extensions/quantlab ' +
			'sibling to .../quantlab-quantbook/quantbook-engine). ' +
			'Set QUANTBOOK_ENGINE_PATH=<absolute path to libql_bindings_node.' +
			`${ext}> to bypass discovery.`,
		);
	}
	// extensionDir is .../{IDE-root}/extensions/quantlab
	// .. twice = IDE-root
	// .. thrice = parent workspace (sibling-of-IDE)
	// + quantlab-quantbook/quantbook-engine/target/release/lib...
	return path.resolve(
		extensionDir,
		'..', '..', '..',
		'quantlab-quantbook', 'quantbook-engine', 'target', 'release',
		`libql_bindings_node.${ext}`,
	);
}

/**
 * Walk UP from `start` looking for the extension's `package.json`
 * (identified by `name: "quantlab"` AND ending in `extensions/quantlab`
 * to disambiguate from any other "quantlab"-named packages). Returns
 * the absolute path to that directory, or `undefined` if not found.
 *
 * Anchoring to the extension instead of the IDE root avoids the
 * worktree-collision issue documented above the caller.
 */
function findExtensionDir(start: string): string | undefined {
	let cur = path.resolve(start);
	for (let depth = 0; depth < 16; depth += 1) {
		const pkgPath = path.join(cur, 'package.json');
		if (fs.existsSync(pkgPath)) {
			try {
				const raw = fs.readFileSync(pkgPath, 'utf8');
				const pkg = JSON.parse(raw) as { name?: string };
				if (pkg.name === 'quantlab' && cur.endsWith(path.join('extensions', 'quantlab'))) {
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
 * Resolve the path to the `relay-server` example binary shipped by
 * `ql-collab-ws` (V3.1.a). Mirrors {@link resolveEnginePath}'s
 * extension-anchor walk-up pattern.
 *
 * **Phase 5.7 V3.1.b (2026-05-22)**: the multi-window IDE demo spawns
 * this binary as a child process so two VS Code windows can each
 * connect via `WebSocketTransport` to a shared localhost ws relay.
 *
 * Failure modes:
 * - `QUANTBOOK_RELAY_BINARY_PATH` set but file doesn't exist -> throws
 *   directing the user to fix the env var.
 * - Anchor walk-up fails (non-canonical workspace) -> throws directing
 *   the user to set `QUANTBOOK_RELAY_BINARY_PATH` as the escape hatch.
 * - Resolved path does not exist (binary not built) -> the caller's
 *   `child_process.spawn` will surface ENOENT.
 */
export function resolveRelayBinaryPath(): string {
	const env = process.env.QUANTBOOK_RELAY_BINARY_PATH;
	if (typeof env === 'string' && env.length > 0) {
		return path.resolve(env);
	}
	const extensionDir = findExtensionDir(__dirname);
	if (extensionDir === undefined) {
		throw new Error(
			'[quantbook loader] Could not locate the extensions/quantlab ' +
			`anchor by walking up from ${__dirname} to resolve the relay ` +
			'binary. Set QUANTBOOK_RELAY_BINARY_PATH=<absolute path to ' +
			'.../target/release/examples/relay-server> to bypass discovery.',
		);
	}
	const binaryName = process.platform === 'win32' ? 'relay-server.exe' : 'relay-server';
	// extensionDir is .../{IDE-root}/extensions/quantlab; .. thrice
	// = parent workspace dir; then quantlab-quantbook/quantbook-engine/
	// target/release/examples/<binary>.
	return path.resolve(
		extensionDir,
		'..', '..', '..',
		'quantlab-quantbook', 'quantbook-engine', 'target', 'release', 'examples',
		binaryName,
	);
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
			// FE-Export-XLSX: `--features xlsx-write` is REQUIRED for `session.export('xlsx')` to return real
			// bytes (else the honest not-implemented error); `test-fixtures` for the mocha contention tests.
			`cd ../quantlab-quantbook/quantbook-engine && cargo build -p ql-bindings-node --release --features xlsx-write,test-fixtures`,
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
	// **Phase 5.7 V1 audit closure (Opus H1 / Codex M1, 2026-05-22):**
	// Validate the loaded module shape BEFORE caching. The prior version
	// assigned `cachedModule` first then validated -- if the validate
	// threw, the BAD module stayed cached and subsequent calls
	// short-circuited via the early `if (cachedModule !== undefined)
	// return` at the top of this function, returning the poisoned module
	// to consumers. The actionable "missing expected exports" error was
	// lost on call #2; consumers saw a cryptic `TypeError: ...
	// CollabSession is not a constructor` at the use site instead.
	//
	// **V2.1 audit closure (Codex MEDIUM-2, 2026-05-22)**: extended the
	// shape-check to include V2.1's new `Transport` (constructor function)
	// and `LoopbackPair` (constructor function) exports. Without this
	// check, a stale V1 binary (built before V2.1 added LoopbackPair)
	// passes loader validation and fails LATER with a cryptic TypeError
	// when consumer code calls `new engine.LoopbackPair()`. Catch it at
	// the boundary instead.
	//
	// **V2.2 audit closure (Codex MEDIUM-1, 2026-05-22)**: V2.2 also
	// requires 5 new CollabSession PROTOTYPE methods
	// (flushDeltaToTransport, pollRemoteWithLimit, transportLastError,
	// setAutoFlushPolicy, autoFlushPolicy). A V2.1-shaped binary
	// (Transport + LoopbackPair present) passes the top-level export
	// check above but fails later when a V2.2 helper calls e.g.
	// `session.flushDeltaToTransport`. Inspect CollabSession.prototype
	// to detect this skew at the boundary.
	const loaded = fakeModule.exports as unknown as QuantbookNativeModule;
	const missing: string[] = [];
	if (typeof loaded.version !== 'function') {
		missing.push('version()');
	}
	if (typeof loaded.CollabSession !== 'function') {
		missing.push('CollabSession constructor');
	}
	if (typeof (loaded as { Transport?: unknown }).Transport !== 'function') {
		missing.push('Transport constructor (V2.1)');
	}
	if (typeof loaded.LoopbackPair !== 'function') {
		missing.push('LoopbackPair constructor (V2.1)');
	}
	// **Phase 6.1B inc.2d (2026-05-28):** the owning `WorkbookSession` over
	// napi -- the new `Session` class. A pre-inc.2d binary lacks it; fail at
	// the boundary (the established per-version discipline above) rather than
	// letting a consumer hit a cryptic `engine.Session is not a constructor`
	// at the use site.
	if (typeof loaded.Session !== 'function') {
		missing.push('Session constructor (6.1B inc.2d)');
	}
	if (typeof loaded.CollabSession === 'function') {
		// V2.2: validate CollabSession.prototype has the V2.2 sync
		// transport methods. (Skip this branch when the V2.1 constructor
		// check itself failed, since `prototype` is undefined for non-
		// function values.)
		const proto = (loaded.CollabSession as unknown as { prototype?: Record<string, unknown> }).prototype;
		if (!proto) {
			missing.push('CollabSession.prototype (V2.2 prototype check)');
		} else {
			for (const method of [
				'flushDeltaToTransport',
				'pollRemoteWithLimit',
				'transportLastError',
				'setAutoFlushPolicy',
				'autoFlushPolicy',
			]) {
				if (typeof proto[method] !== 'function') {
					missing.push(`CollabSession.prototype.${method} (V2.2)`);
				}
			}
			// V2.4 (2026-05-22): `flushPendingToTransport` was REMOVED
			// in V2.3 closure (Codex FAIL + Opus 2H on `&mut self` async
			// aliasing UB + tokio runtime starvation). V2.4 reintroduced
			// after the Arc<Mutex> engine-binding refactor. Check it
			// here so a stale V2.3 binary (lacks flushPendingToTransport)
			// fails at the boundary instead of producing a cryptic
			// "session.flushPendingToTransport is not a function" later.
			if (typeof proto.flushPendingToTransport !== 'function') {
				missing.push('CollabSession.prototype.flushPendingToTransport (V2.4)');
			}
		}
	}
	if (typeof loaded.Session === 'function') {
		// **Phase 6.1B inc.2d (2026-05-28):** validate the `Session`
		// prototype carries the owning-session methods, so a stale/partial
		// binary fails at the boundary instead of at a use site (mirrors the
		// CollabSession.prototype check above).
		const sproto = (loaded.Session as unknown as { prototype?: Record<string, unknown> }).prototype;
		if (!sproto) {
			missing.push('Session.prototype (6.1B inc.2d prototype check)');
		} else {
			for (const method of [
				'addSheet',
				'setValue',
				'setFormula',
				'clear',
				'recalcDirty',
				'recalcAll',
				'snapshot',
				'cell',
				'listSheets',
			]) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.1B inc.2d)`);
				}
			}
			// **Phase 6.4-3d Step 5 (2026-05-29):** the Python-UDF worker
			// injection + event-stream methods. A stale binary (pre-6.4-3d
			// cdylib) lacks these -- fail at the boundary, not at the
			// `setUdfWorker is not a function` use site.
			for (const method of ['setUdfWorker', 'pollEvents']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.4-3d Step 5)`);
				}
			}
			// **Phase 6.3-1b/6.3-1c (2026-05-30):** the recalc start/await/cancel
			// window methods (6.3-1b) + the operation-status reader (6.3-1c). A
			// stale cdylib lacks these -- fail at the boundary, not at the
			// `startRecalcDirty is not a function` use site.
			for (const method of [
				'startRecalcDirty',
				'startRecalcAll',
				'awaitRecalc',
				'cancel',
				'operationStatus',
			]) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-1b/6.3-1c)`);
				}
			}
			// **Phase 6.3-2a (2026-05-30):** the read/lifecycle/format/validate
			// cluster -- the first batch of the 6.3-2 method-binding sweep. A
			// stale cdylib lacks these -- fail at the boundary, not at the use site.
			for (const method of [
				'lifecycleState',
				'validateFormula',
				'queryRange',
				'markVolatilesDirty',
				'setFormat',
				'registerFormat',
			]) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-2a)`);
				}
			}
			// **Phase 6.3-2b (2026-05-30):** persistence -- .qbook open/save +
			// multi-format import/export. A stale cdylib lacks these -- fail at
			// the boundary, not at the use site.
			for (const method of ['open', 'save', 'import', 'export']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-2b)`);
				}
			}
			// **Phase 6.3-2c (2026-05-30):** structure / sheets -- sheet
			// rename/delete/restore/move + defined-name binding.
			for (const method of ['renameSheet', 'deleteSheet', 'restoreSheet', 'moveSheet', 'setName']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-2c)`);
				}
			}
			// **Phase 6.3-2d (2026-05-30):** tables -- create/rename/
			// rename-column/resize/drop.
			for (const method of ['createTable', 'renameTable', 'renameColumn', 'resizeTable', 'dropTable']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-2d)`);
				}
			}
			// **FE-8.3 (2026-06-15):** the table column-name read backing FE-8.1
			// column-shrink + rename-column. A stale cdylib (pre-FE-8.3) lacks it --
			// fail at the boundary, not at the `tableColumns is not a function` use site.
			if (typeof sproto['tableColumns'] !== 'function') {
				missing.push('Session.prototype.tableColumns (FE-8.3)');
			}
			// **Phase 6.3-2e (2026-05-30):** atomic groups (batch + the
			// transaction handle) + the 5 reserved Section 3.5 capability stubs.
			for (const method of [
				'batch', 'beginTransaction', 'txnAdd', 'commitTransaction', 'rollbackTransaction',
				'writeRange', 'publishDataset', 'bindRange', 'refreshSource', 'materializeQuery',
			]) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-2e)`);
				}
			}
			// **Parity backfill (2026-05-30, megaudit X1/X2):** pre-existing bound
			// methods (close = 6.1C M8; the UDF-registration surface = 6.4-2) that
			// were missing from this presence list. A stale cdylib lacks these.
			for (const method of ['close', 'registerFunction', 'unregisterFunction', 'listFunctions']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.1C/6.4-2 parity backfill)`);
				}
			}
			// **Phase 6.3-3 (2026-05-30):** live-grid + ops -- delta + undo/redo.
			for (const method of ['snapshotDelta', 'undo', 'redo', 'canUndo', 'canRedo']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (6.3-3)`);
				}
			}
			// **FE-6 M (2026-06-12):** the MCP write tools' engine surface -- structural
			// insert/delete rows+columns + the cell-style intern/commit pair. A stale cdylib
			// (built before FE-6 M) lacks these; a structural/style MCP write would otherwise fail
			// at the use-site inside `commit` (post-modal) with "X is not a function" instead of
			// loud at the loader boundary. Validated here (the established per-version discipline,
			// alongside the 6.3-2a setFormat/registerFormat format-intern pair above).
			for (const method of [
				'insertRows',
				'deleteRows',
				'insertColumns',
				'deleteColumns',
				'registerStyle',
				'setStyle',
			]) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (FE-6 M)`);
				}
			}
			// **Wave C / R9 (2026-06-18):** the read-only decimal-nudge PREVIEW backing the toolbar's
			// decimal pair (the IDE registers the returned string + applies it via one `batch`, for a
			// single-undo multi-cell nudge). A stale cdylib (pre-Wave-C) lacks it -- fail loud at the loader
			// boundary, not at the `nudgeDecimalsPreview is not a function` use site.
			if (typeof sproto['nudgeDecimalsPreview'] !== 'function') {
				missing.push('Session.prototype.nudgeDecimalsPreview (Wave C / R9)');
			}
			// **Wave G2 / R4 (2026-06-19):** per-sheet row visibility -- set/get the hidden-row set
			// (the engine substrate the Wave G3a collapsing renderer consumes). A stale cdylib
			// (pre-Wave-G2) lacks these -- fail loud at the loader boundary, not at the
			// `setRowsHidden is not a function` use site inside the Hide/Unhide command.
			for (const method of ['setRowsHidden', 'getHiddenRows']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (Wave G2 / R4)`);
				}
			}
			// **Wave Q1 (2026-06-24):** persistent chart objects -- the add/update/remove/list CRUD surface
			// the cell grid drives for Insert Chart + the .qbook v12 envelope. A stale cdylib (pre-Wave-Q1)
			// lacks these -- fail loud at the loader boundary, not at the `addChart is not a function` use
			// site inside the chart-insert handler.
			for (const method of ['addChart', 'updateChart', 'removeChart', 'listCharts']) {
				if (typeof sproto[method] !== 'function') {
					missing.push(`Session.prototype.${method} (Wave Q1)`);
				}
			}
		}
	}
	if (typeof (loaded as { Transport?: unknown }).Transport === 'function') {
		// V2.3 (2026-05-22): validate `Transport.websocketConnect`
		// static async factory. A V2.2-shaped binary lacks this export
		// and would fail late with `Transport.websocketConnect is not a
		// function` when V2.3 helpers call it. Closure for Codex MEDIUM
		// (V2.3 audit, 2026-05-22).
		const transport = loaded.Transport as unknown as { websocketConnect?: unknown };
		if (typeof transport.websocketConnect !== 'function') {
			missing.push('Transport.websocketConnect (V2.3)');
		}
	}
	// V2.6 (2026-05-22): `BlockingTransportFixture` is the V2.5
	// contract-test fixture for the V8-block closure. Pre-V2.8 it was
	// required (`ql-bindings-node` enabled `ql-collab/test-fixtures`
	// unconditionally, so every cdylib carried it).
	//
	// **V2.8 megaudit closure (Opus-B Lane C HIGH-1 + Lane A LOW-1
	// convergent, 2026-05-22)**: the fixture is now feature-gated on
	// `ql-bindings-node`'s `test-fixtures` Cargo feature. Production
	// builds compile WITHOUT it; mocha + contention contract test
	// builds compile WITH it. Therefore the loader treats the fixture
	// as OPTIONAL -- its absence is no longer a binary-staleness
	// signal, just a production build.
	//
	// Callers that need the fixture (mocha contract tests) check
	// `engine.BlockingTransportFixture` explicitly and throw a clear
	// "rebuild with --features test-fixtures" message if absent.
	if (missing.length > 0) {
		throw new Error(
			`Quantbook engine at ${enginePath} loaded but is missing expected exports: ` +
			`[${missing.join(', ')}]. ` +
			`Got: ${JSON.stringify(Object.keys(fakeModule.exports))}. ` +
			`This indicates a stale binary -- rebuild with: ` +
			// FE-Export-XLSX: keep `--features xlsx-write` so the rebuild does not silently drop xlsx export.
			`cargo build -p ql-bindings-node --release --features xlsx-write,test-fixtures.`,
		);
	}
	cachedModule = loaded;
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
