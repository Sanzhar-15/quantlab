/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step D bridge: when a user clicks "Visualise" on a CSV/parquet/xlsx,
 * we either open an existing companion `.qviz.json` next to the data
 * file OR generate a draft one and open that. This module owns the
 * pure logic for both halves:
 *
 *   - `companionSpecPath` -- given the data file's absolute fs path,
 *     return the absolute fs path of the companion spec (same dir,
 *     same basename, `.qviz.json` extension).
 *   - `buildDraftSpecForDataset` -- given a workspace-relative dataset
 *     URI, produce a valid `QvizSpec` skeleton that:
 *       1. references the real CSV via `dataset.uri`
 *       2. carries a syntactically-valid placeholder `schema_hash`
 *          (real one is refreshed via the drift detector's
 *          save-with-refresh path on first save)
 *       3. picks a chart type + encodings that satisfy the validator
 *          (the user replaces field names via the builder UI as
 *          their first action; placeholder fields are flagged by the
 *          daemon's schema fetch).
 *
 * Kept vscode-free so it's directly unit-testable. The file-creating
 * `ensureCompanionSpec` lives in `DataViewManager` (which owns the
 * vscode.workspace.fs adapter); only the path math + spec builder
 * are here.
 */

import * as nodePath from 'path';

import { type QvizSpec, QVIZ_SCHEMA_VERSION } from './spec';

/** Canonical placeholder hash for drafts that haven't been schema-fetched
 *  yet. Lives in this vscode-free module so both the dataset-side draft
 *  (here) and the document-side empty-file draft (`QvizSpecDocument`)
 *  can import the same constant. The all-zeros sha256 satisfies the
 *  validator's `^sha256:[0-9a-f]{64}$` regex without colliding with any
 *  legitimate hash of real data. */
export const PLACEHOLDER_SCHEMA_HASH = 'sha256:' + '0'.repeat(64);

/**
 * Compute the companion spec path for a data file.
 *
 *   `/ws/data/prices.csv`            -> `/ws/data/prices.qviz.json`
 *   `/ws/data/prices.parquet`        -> `/ws/data/prices.qviz.json`
 *   `/ws/INDEX_BTCUSD, 1D (4).csv`   -> `/ws/INDEX_BTCUSD, 1D (4).qviz.json`
 *   `/ws/data/prices.qviz.json`      -> ` /ws/data/prices.qviz.json`  (idempotent)
 *
 * Implementation note: the data file's CURRENT extension is stripped
 * (csv/parquet/xlsx). A passed-in `.qviz.json` is returned as-is so
 * `switchToVisualise` can call this uniformly without checking the
 * input type first.
 */
export function companionSpecPath(dataFileFsPath: string): string {
	if (dataFileFsPath.endsWith('.qviz.json')) {
		return dataFileFsPath;
	}
	const dir = nodePath.dirname(dataFileFsPath);
	const base = nodePath.basename(dataFileFsPath);
	// Strip the final extension regardless of what it is. We don't
	// special-case csv/parquet/xlsx here -- the caller has already
	// validated via `isDataFile`; if a future supported extension is
	// added, this still does the right thing.
	const dot = base.lastIndexOf('.');
	const stem = dot > 0 ? base.slice(0, dot) : base;
	return nodePath.join(dir, `${stem}.qviz.json`);
}

/**
 * Construct a valid draft `QvizSpec` for a CSV/parquet/xlsx that the
 * user just chose to "Visualise". MUST pass `validateOrThrow`.
 *
 * The chart type defaults to `scatter` (general family) because:
 *   - it requires only `x` and `y`, no domain-specific channels;
 *   - it works visually for any two numeric columns -- the user can
 *     swap to line/bar/candlestick from the chart-type picker without
 *     re-entering field bindings;
 *   - histogram would also work but the single-x layout is less
 *     informative as a first impression.
 *
 * Audit fix (2026-05-11): encodings is intentionally `{}` (empty) rather
 * than a placeholder `{x: 'x', y: 'y'}`. The previous placeholders pointed
 * at column names that almost never exist in real data, so the very first
 * render attempt threw "encodings.x.field='x' not in column data" before
 * the user could see the column panel. With empty encodings the compiler
 * throws a clearer "scatter chart requires encodings.x and encodings.y"
 * which routes through diagnostics and matches the actionable empty state
 * the builder UI is trying to communicate. The validator accepts empty
 * encodings (per the relaxation earlier today) so the spec round-trips
 * cleanly to disk and back.
 */
export function buildDraftSpecForDataset(
	workspaceRelativeUri: string,
): QvizSpec {
	if (typeof workspaceRelativeUri !== 'string' || workspaceRelativeUri.length === 0) {
		throw new Error('buildDraftSpecForDataset: workspaceRelativeUri must be a non-empty string');
	}
	return {
		qviz_version: QVIZ_SCHEMA_VERSION,
		title: '',
		dataset: {
			uri: workspaceRelativeUri,
			schema_hash: PLACEHOLDER_SCHEMA_HASH,
			mtime_ns: 0,
			row_count: 0,
		},
		transforms: [],
		chart: {
			family: 'general',
			type: 'scatter',
			encodings: {},
		},
		provenance: {
			generator: 'manual',
			generated_at: new Date().toISOString(),
			// Megaudit Theme G (G14, 2026-05-13): use the canonical zero
			// sentinel (matches defaults.ts / persist.ts emitters). The
			// previous '' was asymmetric with every other emitter and a
			// future regex tightening on query_hash would silently break
			// drafts.
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: QVIZ_SCHEMA_VERSION },
			source: 'user-built',
		},
	};
}

/**
 * Compute the workspace-relative URI to embed in the draft's
 * `dataset.uri` field. Strips the workspace root prefix and normalizes
 * to forward-slash separators (the .qviz.json format is POSIX-style
 * regardless of host platform -- a spec authored on macOS must open
 * on Windows referring to the same file).
 *
 * Returns null if the data file is outside the given workspace root.
 * Callers should already have refused such inputs at the
 * `assertSafeDataFilePath` boundary, but the explicit null here
 * surfaces any wiring bug rather than silently writing a malformed
 * absolute path into the spec.
 */
export function workspaceRelativeDatasetUri(
	dataFileFsPath: string,
	workspaceRootFsPath: string,
): string | null {
	const rel = nodePath.relative(workspaceRootFsPath, dataFileFsPath);
	if (rel === '' || rel.startsWith('..') || nodePath.isAbsolute(rel)) {
		return null;
	}
	// Normalize to POSIX separators for cross-platform spec portability.
	return rel.split(nodePath.sep).join('/');
}
