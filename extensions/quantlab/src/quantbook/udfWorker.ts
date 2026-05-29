/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 6.4-3d Step 5 (2026-05-29) -- IDE-side Python-UDF worker injection.
 *
 * Builds a {@link PythonWorkerConfigJson} and attaches it to an owning
 * {@link SessionInstance} via `setUdfWorker`, behind two gates the engine cannot
 * enforce (it has no workspace concept):
 *
 *   1. **Workspace trust.** A UDF worker runs ARBITRARY workspace Python. We
 *      refuse to spawn one in an untrusted workspace, surfacing the IDE-only
 *      `[worker_untrusted_workspace]` code (caller shows a non-fatal notice).
 *   2. **Interpreter resolution.** The interpreter comes from the existing
 *      `quantlab.pythonPath` cascade (see `../qviz/pythonPath`), verified to be
 *      Python >= 3.9 (the worker is 3.9-compatible) before we hand it to the
 *      engine.
 *
 * `setUdfWorker` is a SYNCHRONOUS napi method that blocks the calling thread up
 * to the handshake timeout. {@link injectUdfWorker} is `async` and yields before
 * the call; callers MUST invoke it OFF the UI/keystroke path. (Converting the
 * engine method to an async napi `AsyncTask` is filed-forward; today the call
 * runs on this thread.)
 *
 * The planning step ({@link planUdfWorkerConfig}) is a PURE function (no vscode /
 * no spawn) so the trust + resolution + version logic is unit-testable; only the
 * thin {@link injectUdfWorker} wrapper touches vscode + the singleton TrustManager.
 */

import * as path from 'path';

import { resolveQuantlabPython, verifyPythonVersion, type ResolvedPython } from '../qviz/pythonPath';
import { resolveEnginePath } from './loader';
import type { PythonWorkerConfigJson, SessionInstance } from './types';

// `vscode` + `TrustManager` are imported LAZILY inside `injectUdfWorker` (the
// only vscode-touching entry point) so this module's top-level import graph
// stays vscode-free -- keeping the pure planner + diagnostics helpers importable
// (and unit-testable) in plain mocha without the vscode shim (mirrors the
// `../qviz/pythonPath` discipline).

/** Minimum interpreter version -- the worker (`quantbook.worker`) is 3.9-compatible. */
export const UDF_MIN_PY_MAJOR = 3;
export const UDF_MIN_PY_MINOR = 9;

/**
 * Default eager-handshake timeout (ms). A cold `import pyarrow` in a freshly
 * spawned interpreter can take several seconds; the engine default (5000) is too
 * tight when the IDE host has never warmed the interpreter, so the helper passes
 * a generous default. Capped engine-side at 600000.
 */
export const UDF_DEFAULT_HANDSHAKE_MS = 30_000;

/**
 * Resolve the engine's `crates/quantbook-py/python` directory (the `quantbook`
 * package + the worker module live here).
 *
 * Resolution: an explicit `QUANTBOOK_PY_DIR` env override wins; otherwise it is
 * DERIVED from {@link resolveEnginePath} assuming the CANONICAL dev layout
 * (`.../quantbook-engine/target/release/lib...` -> up 2 -> `.../quantbook-engine`
 * -> `crates/quantbook-py/python`).
 *
 * 6.4-3d Step 5 audit-fix (Opus MED): the derivation only holds for the
 * canonical layout. If `QUANTBOOK_ENGINE_PATH` points the cdylib OUTSIDE that
 * layout (e.g. a copied binary), the up-2 derivation yields a bogus dir and the
 * worker fails to `import quantbook.worker` (surfacing as `[worker_spawn_failed]`).
 * In that case set `QUANTBOOK_PY_DIR` explicitly to the engine's
 * `crates/quantbook-py/python`.
 */
export function resolveQuantbookPyDir(): string {
	const override = process.env.QUANTBOOK_PY_DIR;
	if (override !== undefined && override.length > 0) {
		return override;
	}
	const enginePath = resolveEnginePath();
	// dirname = target/release; up two = the quantbook-engine crate root.
	const engineRoot = path.resolve(path.dirname(enginePath), '..', '..');
	return path.join(engineRoot, 'crates', 'quantbook-py', 'python');
}

/** Lazy interpreter version check (only invoked once the trust gate passes). */
export type VersionCheck = (pythonPath: string) => { ok: boolean; error?: string };

export interface PlanUdfWorkerInputs {
	/** Result of the workspace-trust check (`true` = trusted). */
	readonly isWorkspaceTrusted: boolean;
	/** The resolved interpreter (or `null` when none was found). */
	readonly resolvedPython: ResolvedPython | null;
	/** The engine `quantbook-py/python` dir (first PYTHONPATH entry). */
	readonly quantbookPyDir: string;
	/**
	 * Optional version check, invoked ONLY after the trust gate passes and an
	 * interpreter resolved -- so an untrusted workspace never spawns a subprocess.
	 */
	readonly versionCheck?: VersionCheck;
	/** Trusted user module the worker imports to register UDFs by handle. */
	readonly udfModule?: string;
	/** Extra PYTHONPATH dirs appended after {@link quantbookPyDir} (e.g. the workspace UDF dir). */
	readonly extraPythonPath?: readonly string[];
	/** Handshake timeout override (ms). Defaults to {@link UDF_DEFAULT_HANDSHAKE_MS}. */
	readonly handshakeTimeoutMs?: number;
}

/**
 * PURE: build the worker config, applying the trust + resolution + version
 * gates. Throws a `[code] message` engine-style error on any gate failure (so
 * the caller can `parseQuantbookError` it uniformly):
 *   - `[worker_untrusted_workspace]` -- workspace not trusted (no spawn).
 *   - `[worker_spawn_failed]` -- no interpreter found, OR the interpreter is too
 *     old / not runnable (the version check failed).
 *
 * No I/O beyond the injected `versionCheck` (which the caller wires to
 * `verifyPythonVersion`); never touches vscode.
 */
export function planUdfWorkerConfig(inp: PlanUdfWorkerInputs): PythonWorkerConfigJson {
	if (!inp.isWorkspaceTrusted) {
		throw new Error(
			'[worker_untrusted_workspace] refusing to launch a Python UDF worker: the workspace is not ' +
			'trusted. A UDF worker runs arbitrary workspace Python -- trust the workspace to enable Python UDFs.',
		);
	}
	if (inp.resolvedPython === null) {
		throw new Error(
			'[worker_spawn_failed] no Python interpreter found. Set `quantlab.pythonPath` (or ' +
			'`python.defaultInterpreterPath`, or create ~/.quantlab/venv) to a Python >= ' +
			`${UDF_MIN_PY_MAJOR}.${UDF_MIN_PY_MINOR} with pyarrow installed.`,
		);
	}
	const python = inp.resolvedPython.pythonPath;
	if (inp.versionCheck) {
		const v = inp.versionCheck(python);
		if (!v.ok) {
			throw new Error(`[worker_spawn_failed] interpreter ${python} is not usable: ${v.error ?? 'unknown'}`);
		}
	}
	const pythonpath = [inp.quantbookPyDir, ...(inp.extraPythonPath ?? [])];
	const config: PythonWorkerConfigJson = {
		python,
		pythonpath,
		handshakeTimeoutMs: inp.handshakeTimeoutMs ?? UDF_DEFAULT_HANDSHAKE_MS,
	};
	// Per napi-rs: OMIT optional fields when unset (do not pass `undefined`-valued).
	if (inp.udfModule !== undefined && inp.udfModule.length > 0) {
		config.udfModule = inp.udfModule;
	}
	return config;
}

export interface InjectUdfWorkerOptions {
	/** Workspace URI for the trust gate (e.g. `workspaceFolders[0].uri.toString()`). */
	readonly workspaceUri: string;
	/** Trusted user module the worker imports to register UDFs by handle. */
	readonly udfModule?: string;
	/** Extra PYTHONPATH dirs (e.g. the workspace UDF directory). */
	readonly extraPythonPath?: readonly string[];
	/** Handshake timeout override (ms). Defaults to {@link UDF_DEFAULT_HANDSHAKE_MS}. */
	readonly handshakeTimeoutMs?: number;
}

/**
 * Resolve config from the workspace + the `quantlab.pythonPath` cascade, gate on
 * trust, and attach the worker to `session`.
 *
 * **WARNING -- this BLOCKS the extension-host thread.** `setUdfWorker` is a
 * SYNCHRONOUS napi method that blocks until the worker handshake completes (up to
 * `handshakeTimeoutMs`, default 30s). The `await` below only defers it to a later
 * microtask -- a VS Code extension host is single-threaded, so when the call
 * runs it freezes the host (UI commands, other extensions) for the duration.
 * There is no worker-thread offload here; the only real mitigations are a short
 * `handshakeTimeoutMs` or the filed-forward async-napi `AsyncTask` variant. Do
 * NOT call this on a keystroke/hot path; prefer an explicit user action + a
 * progress notification at the (future) live call site.
 *
 * On success the caller should `session.recalcAll()` so existing `#CALC!` UDF
 * cells pick up the worker (`recalcDirty` will not heal them).
 *
 * Throws `[worker_untrusted_workspace]` / `[worker_spawn_failed]` /
 * `[worker_handshake]` / `[invalid_state]` / `[session_busy]` /
 * `[bad_argument]` -- all `parseQuantbookError`-parseable.
 */
export async function injectUdfWorker(
	session: SessionInstance,
	opts: InjectUdfWorkerOptions,
): Promise<void> {
	// Lazy runtime imports (see the top-of-file note): keeps this module's
	// top-level graph vscode-free for testability.
	const vscode = await import('vscode');
	const { TrustManager } = await import('../core/trust/TrustManager');

	// 6.4-3d Step 5 audit-fix (Codex HIGH): require BOTH VS Code Restricted-Mode
	// trust (`vscode.workspace.isTrusted`) AND QuantLab's own workspace-trust
	// store. A workspace can be trusted in QuantLab's map yet opened in VS Code
	// Restricted Mode, where extensions MUST NOT execute workspace code -- and a
	// UDF worker runs arbitrary workspace Python. Gate FIRST, before resolving any
	// interpreter path (no fs probing for an untrusted workspace).
	const isWorkspaceTrusted =
		vscode.workspace.isTrusted &&
		TrustManager.getInstance().isWorkspaceTrusted(opts.workspaceUri);

	// Resolve the interpreter ONLY when trusted; `planUdfWorkerConfig` throws
	// `[worker_untrusted_workspace]` first when not, so we never stat/spawn for an
	// untrusted workspace.
	const resolvedPython = isWorkspaceTrusted
		? resolveQuantlabPython({
			quantlabConfigPath:
				vscode.workspace.getConfiguration('quantlab').get<string>('pythonPath') || undefined,
			pythonExtConfigPath:
				vscode.workspace.getConfiguration('python').get<string>('defaultInterpreterPath') || undefined,
		})
		: null;

	const config = planUdfWorkerConfig({
		isWorkspaceTrusted,
		resolvedPython,
		quantbookPyDir: resolveQuantbookPyDir(),
		versionCheck: (p) => {
			const r = verifyPythonVersion(p, UDF_MIN_PY_MAJOR, UDF_MIN_PY_MINOR);
			return r.ok ? { ok: true } : { ok: false, error: r.error };
		},
		udfModule: opts.udfModule,
		extraPythonPath: opts.extraPythonPath,
		handshakeTimeoutMs: opts.handshakeTimeoutMs,
	});

	// Defer to a later microtask so we never run the blocking call inline on a
	// synchronous caller's tick (see the WARNING above -- this does NOT take it
	// off the host thread).
	await Promise.resolve();
	session.setUdfWorker(config);
}
