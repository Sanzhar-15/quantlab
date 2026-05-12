/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Persist module -- Phase 5 step 5.C.1.
 *
 * Pure module. No vscode imports. No I/O against the workspace beyond
 * `fs.realpathSync` / `fs.statSync` for symlink + extension validation.
 * Bridge between a `QvizSpec`'s workspace-relative `dataset.uri` and
 * the absolute filesystem path the daemon needs.
 *
 * Failure surface (CLAUDE.md "structured errors not throws"): every
 * resolution that can fail returns a tagged result. Callers are
 * required to discriminate; there is no fallback path that papers
 * over a missing workspace or a path-escape attempt.
 *
 * Concerns owned by this module:
 *   - Workspace-relative path normalization. Reject absolute paths,
 *     ".." escapes, symlink targets that resolve outside the
 *     workspace.
 *   - Extension allowlist (parquet/csv/xlsx). Mirrors the daemon's
 *     allowlist (python/qviz/security.py). Centralizing here means
 *     the extension host catches forbidden URIs BEFORE the spec
 *     reaches the daemon.
 *   - Provenance refresh: when a spec is being saved AND the on-disk
 *     schema_hash drifted from the spec's recorded hash but the spec
 *     is still valid (Step 5.C.2 'fields-preserved'), this module
 *     produces an updated spec with the new schema_hash + bumped
 *     `provenance.generated_at`.
 *
 * Concerns NOT in this module:
 *   - Daemon dispatch (daemon-lifecycle / daemon-client).
 *   - Drift detection (schemaDrift.ts).
 *   - VS Code editor lifecycle (QvizSpecDocument).
 */

import * as fs from 'fs';
import * as path from 'path';

import type { QvizSpec, Provenance } from './spec';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export type ResolveDatasetError =
	| { readonly kind: 'no-workspace'; readonly message: string }
	| { readonly kind: 'empty-uri'; readonly message: string }
	| { readonly kind: 'absolute-uri'; readonly uri: string; readonly message: string }
	| { readonly kind: 'path-escape'; readonly uri: string; readonly message: string }
	| { readonly kind: 'symlink-escape'; readonly uri: string; readonly resolved: string; readonly message: string }
	| { readonly kind: 'extension-not-allowed'; readonly uri: string; readonly extension: string; readonly message: string }
	| { readonly kind: 'missing'; readonly uri: string; readonly absPath: string; readonly message: string }
	| { readonly kind: 'dangling-symlink'; readonly uri: string; readonly absPath: string; readonly message: string }
	| { readonly kind: 'access-denied'; readonly uri: string; readonly absPath: string; readonly errorCode: string; readonly message: string }
	| { readonly kind: 'system-error'; readonly uri: string; readonly absPath: string; readonly errorCode: string; readonly message: string }
	| { readonly kind: 'not-file'; readonly uri: string; readonly absPath: string; readonly message: string };

/** Discriminated success type. `absPath` is guaranteed:
 *   - absolute,
 *   - inside the workspace root (after realpath resolution),
 *   - to point at a regular file (not a directory),
 *   - to have an allowlisted extension.
 */
export interface ResolvedDataset {
	readonly kind: 'ok';
	readonly absPath: string;
	readonly mtime_ns: number;
	readonly size: number;
}

export type ResolveDatasetResult = ResolvedDataset | ResolveDatasetError;

/**
 * Extension allowlist. MUST match the daemon's actual READER support
 * in `python/qviz/reader.py` (NOT `security.py`'s gate, which lists
 * extensions the SECURITY layer allows but the reader rejects). The
 * reader supports parquet, csv, tsv only; xlsx/xls raise
 * NotImplementedError. Listing them here would let the user save a
 * spec that the daemon then rejects.
 *
 * Step C megaudit C13: prior list included `.xlsx` (mismatching the
 * reader) and omitted `.tsv` (which the reader does support).
 */
const ALLOWED_EXTENSIONS = new Set(['.parquet', '.csv', '.tsv']);

/**
 * Resolve `spec.dataset.uri` (workspace-relative) to an absolute path.
 * The path is realpath-resolved so symlinks pointing outside the
 * workspace are rejected.
 *
 * Returns a tagged result. Callers discriminate via `result.kind`.
 */
export function resolveDatasetPath(
	uri: string,
	workspaceRoot: string | null,
): ResolveDatasetResult {
	if (workspaceRoot === null) {
		return {
			kind: 'no-workspace',
			message: 'no workspace folder is open; .qviz.json datasets must resolve relative to a workspace',
		};
	}
	if (uri.length === 0) {
		return {
			kind: 'empty-uri',
			message: 'dataset uri must be a non-empty workspace-relative path',
		};
	}
	if (path.isAbsolute(uri)) {
		return {
			kind: 'absolute-uri',
			uri,
			message: `dataset uri must be workspace-relative, got absolute path ${JSON.stringify(uri)}`,
		};
	}
	// Reject Windows-style absolute paths and UNC paths even on POSIX.
	// `path.isAbsolute` is platform-specific; on POSIX it doesn't catch
	// `C:\...` or `\\server\share`. Rejecting here keeps the security
	// gate consistent across platforms.
	if (/^[a-zA-Z]:[\\/]/.test(uri) || uri.startsWith('\\\\')) {
		return {
			kind: 'absolute-uri',
			uri,
			message: `dataset uri must be workspace-relative POSIX path, got Windows-style ${JSON.stringify(uri)}`,
		};
	}
	// Normalize the joined path. `path.normalize` collapses `..` segments
	// but does NOT resolve symlinks; we still need realpath below for
	// symlink escape detection.
	const joined = path.normalize(path.join(workspaceRoot, uri));
	const wsNormalized = path.normalize(workspaceRoot);
	if (!isPathInside(wsNormalized, joined)) {
		return {
			kind: 'path-escape',
			uri,
			message: `dataset uri ${JSON.stringify(uri)} escapes workspace via '..'`,
		};
	}

	// realpath: catches symlinks pointing outside the workspace. The
	// workspace root itself is realpath'd too so a workspace that IS
	// a symlink to a "real" location compares apples-to-apples.
	let realFile: string;
	let realRoot: string;
	try {
		realFile = fs.realpathSync(joined);
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		const code = err.code ?? 'UNKNOWN';
		// Step C megaudit Major: prior code mapped EVERY non-success to
		// `missing`, hiding permission errors and dangling symlinks.
		// Discriminate explicitly so callers and users can act.
		if (code === 'ENOENT') {
			// Distinguish a "file simply doesn't exist" from a "file is
			// a symlink whose target is gone": lstatSync of the joined
			// path tells us if a symlink itself is present.
			// Megaudit M-28 residual: previously a silent `catch {}`
			// that returned `false` for ANY error. Permission-denied
			// on the parent dir would mask a legitimate symlink as
			// "not a symlink." Now distinguish ENOENT (the lstat
			// itself says "not present" -- consistent with the outer
			// realpath ENOENT we're already handling) from other
			// errors which surface a system-error result instead.
			let isDanglingSymlink = false;
			try {
				const ls = fs.lstatSync(joined);
				isDanglingSymlink = ls.isSymbolicLink();
			} catch (lstatErr) {
				const lstatCode = (lstatErr as NodeJS.ErrnoException).code;
				if (lstatCode !== 'ENOENT') {
					return {
						kind: 'system-error',
						uri,
						absPath: joined,
						errorCode: lstatCode ?? 'UNKNOWN',
						message: `dataset uri ${JSON.stringify(uri)}: lstat failed (${lstatCode}): `
							+ (lstatErr as Error).message,
					};
				}
			}
			if (isDanglingSymlink) {
				return {
					kind: 'dangling-symlink',
					uri,
					absPath: joined,
					message: `dataset uri ${JSON.stringify(uri)} is a symlink whose target no longer exists (${err.message})`,
				};
			}
			return {
				kind: 'missing',
				uri,
				absPath: joined,
				message: `dataset file not found at ${joined}: ${err.message}`,
			};
		}
		if (code === 'EACCES' || code === 'EPERM') {
			return {
				kind: 'access-denied',
				uri,
				absPath: joined,
				errorCode: code,
				message: `dataset file at ${joined} access denied (${code}): ${err.message}`,
			};
		}
		// Other fs errors: ELOOP (too many symlinks), EIO, ENOTDIR, etc.
		return {
			kind: 'system-error',
			uri,
			absPath: joined,
			errorCode: code,
			message: `dataset file at ${joined} not accessible (${code}): ${err.message}`,
		};
	}
	try {
		realRoot = fs.realpathSync(wsNormalized);
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		const code = err.code ?? 'UNKNOWN';
		return {
			kind: 'no-workspace',
			message: `workspace root ${JSON.stringify(workspaceRoot)} could not be resolved (${code}): ${err.message}`,
		};
	}
	if (!isPathInside(realRoot, realFile)) {
		return {
			kind: 'symlink-escape',
			uri,
			resolved: realFile,
			message: `dataset uri ${JSON.stringify(uri)} resolves through symlinks to ${realFile}, outside workspace ${realRoot}`,
		};
	}

	const ext = path.extname(realFile).toLowerCase();
	if (!ALLOWED_EXTENSIONS.has(ext)) {
		return {
			kind: 'extension-not-allowed',
			uri,
			extension: ext || '(none)',
			message: `dataset extension ${ext || '(none)'} not allowed; expected one of ${[...ALLOWED_EXTENSIONS].join(', ')}`,
		};
	}

	let stat: ReturnType<typeof fs.statSync> & { mtimeNs: bigint; size: bigint };
	try {
		stat = fs.statSync(realFile, { bigint: true }) as typeof stat;
	} catch (e) {
		const err = e as NodeJS.ErrnoException;
		const code = err.code ?? 'UNKNOWN';
		// statSync after a successful realpathSync is rare to fail, but
		// it CAN happen -- file deleted between the two calls (TOCTOU
		// window). Map to the closest existing error kind.
		if (code === 'ENOENT') {
			return {
				kind: 'missing', uri, absPath: realFile,
				message: `dataset disappeared between realpath and stat: ${err.message}`,
			};
		}
		if (code === 'EACCES' || code === 'EPERM') {
			return {
				kind: 'access-denied', uri, absPath: realFile, errorCode: code,
				message: `dataset stat denied (${code}): ${err.message}`,
			};
		}
		return {
			kind: 'system-error', uri, absPath: realFile, errorCode: code,
			message: `dataset stat failed (${code}): ${err.message}`,
		};
	}
	if (!stat.isFile()) {
		return {
			kind: 'not-file',
			uri,
			absPath: realFile,
			message: `dataset path ${realFile} is not a regular file`,
		};
	}
	// `mtimeNs` is a bigint (Node's bigint stat). Convert to JS number;
	// modern timestamps exceed Number.MAX_SAFE_INTEGER (~year 2255 ns
	// since epoch -- mtimeNs around 1.7e18 in 2026 is way past 2^53).
	// We accept the precision loss: the daemon's TOCTOU fingerprint
	// already includes (mtime + size + ctime + schema_hash), so sub-
	// microsecond rounding on mtime is benign. The protocol's
	// SchemaInfo.mtime_ns is documented as Number.isFinite, not
	// safe-integer.
	const mtime_ns = Number(stat.mtimeNs);
	const size = Number(stat.size);
	if (!Number.isFinite(mtime_ns)) {
		throw new Error(`fs.statSync.mtimeNs produced non-finite number from bigint ${stat.mtimeNs}`);
	}
	if (!Number.isFinite(size)) {
		throw new Error(`fs.statSync.size produced non-finite number from bigint ${stat.size}`);
	}
	return { kind: 'ok', absPath: realFile, mtime_ns, size };
}

/**
 * Apply a schema-hash refresh to a spec. Used at save time when the
 * data file's schema changed but the user's spec is still valid
 * against it (Step 5.C.2 'fields-preserved' branch). The new spec
 * has:
 *   - `dataset.schema_hash` updated to the live hash,
 *   - `dataset.mtime_ns` updated to the live file mtime,
 *   - `dataset.row_count` updated to the new schema's row count
 *     (or removed if not provided by the live schema). The OLD
 *     row_count is wrong now that the schema changed.
 *   - `provenance.generated_at` bumped to `nowIso`.
 *   - `provenance.query_hash` reset to the all-zero sentinel
 *     ('sha256:0...0'). The old `query_hash` reflected an aggregate
 *     plan keyed against the OLD schema; that cache key is no longer
 *     valid. Step C megaudit P3.
 *
 * Pure function: returns a fresh spec object; the input is unchanged.
 */
export function refreshDatasetProvenance(
	spec: QvizSpec,
	args: {
		newSchemaHash: string;
		newMtimeNs: number;
		newRowCount?: number | null;
		nowIso: string;
	},
): QvizSpec {
	const ZERO_QUERY_HASH = 'sha256:' + '0'.repeat(64);
	const provenance: Provenance = {
		...spec.provenance,
		generated_at: args.nowIso,
		query_hash: ZERO_QUERY_HASH,
	};
	const dataset = {
		...spec.dataset,
		schema_hash: args.newSchemaHash,
		mtime_ns: args.newMtimeNs,
	};
	// Drop or update row_count to reflect the live schema.
	if (args.newRowCount === null || args.newRowCount === undefined) {
		// New schema doesn't know row_count; drop the stale value rather
		// than preserve a number that no longer matches the file.
		const { row_count: _drop, ...withoutRowCount } = dataset;
		void _drop;
		return {
			...spec,
			dataset: withoutRowCount,
			provenance,
		};
	}
	return {
		...spec,
		dataset: { ...dataset, row_count: args.newRowCount },
		provenance,
	};
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** True iff `child` is `parent` or under it. Both are expected to be
 *  normalized absolute paths. The relative-path-doesn't-start-with-..
 *  trick handles the common cases correctly on POSIX and Windows. */
function isPathInside(parent: string, child: string): boolean {
	const rel = path.relative(parent, child);
	if (rel === '') { return true; }
	if (rel.startsWith('..')) { return false; }
	if (path.isAbsolute(rel)) { return false; }
	return true;
}

