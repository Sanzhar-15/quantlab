/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Step D bridge (Phase 5): unit tests for the vscode-free half of the
 * "Visualise a CSV → open in spec builder" flow. The file-creating
 * `DataViewManager.ensureCompanionSpec` half is covered by the
 * existing VS-Code integration tests (it needs the shim); this file
 * exercises pure path math + draft-spec construction.
 */

import * as assert from 'assert';
import * as nodePath from 'path';

import {
	buildDraftSpecForDataset,
	companionSpecPath,
	workspaceRelativeDatasetUri,
	PLACEHOLDER_SCHEMA_HASH,
} from '../src/qviz/draftFromDataset';
import { validate } from '../src/qviz/validate';

suite('Step D — companionSpecPath', () => {
	test('replaces .csv extension with .qviz.json', () => {
		assert.strictEqual(
			companionSpecPath('/ws/data/prices.csv'),
			nodePath.join('/ws/data', 'prices.qviz.json'),
		);
	});

	test('replaces .parquet extension with .qviz.json', () => {
		assert.strictEqual(
			companionSpecPath('/ws/data/prices.parquet'),
			nodePath.join('/ws/data', 'prices.qviz.json'),
		);
	});

	test('replaces .xlsx extension with .qviz.json', () => {
		assert.strictEqual(
			companionSpecPath('/ws/sub/sheet.xlsx'),
			nodePath.join('/ws/sub', 'sheet.qviz.json'),
		);
	});

	test('handles filenames with spaces, commas, parens', () => {
		// Real-world example from the smoke session: TradingView export
		// names like `INDEX_BTCUSD, 1D (4).csv` must survive untouched
		// except for the extension swap.
		assert.strictEqual(
			companionSpecPath('/ws/INDEX_BTCUSD, 1D (4).csv'),
			nodePath.join('/ws', 'INDEX_BTCUSD, 1D (4).qviz.json'),
		);
	});

	test('is idempotent on a .qviz.json input', () => {
		// `switchToVisualise` may be called on a file that's already a
		// spec (e.g. someone bound the keybinding to a non-CSV); just
		// return it as-is so the caller can open it uniformly.
		const p = '/ws/data/prices.qviz.json';
		assert.strictEqual(companionSpecPath(p), p);
	});

	test('handles a basename without an extension by appending .qviz.json', () => {
		// Edge case: no dot in the basename at all. The function should
		// not strip the leading slash or treat the entire path as a name.
		assert.strictEqual(
			companionSpecPath('/ws/prices'),
			nodePath.join('/ws', 'prices.qviz.json'),
		);
	});

	test('keeps dotfile-only basename intact (no extension to strip)', () => {
		// A dotfile like `.envrc` has no extension to strip; the helper
		// should append `.qviz.json` rather than strip the leading dot.
		assert.strictEqual(
			companionSpecPath('/ws/.envrc'),
			nodePath.join('/ws', '.envrc.qviz.json'),
		);
	});
});

suite('Step D — workspaceRelativeDatasetUri', () => {
	test('strips workspace prefix and uses forward slashes', () => {
		const rel = workspaceRelativeDatasetUri('/ws/data/prices.csv', '/ws');
		assert.strictEqual(rel, 'data/prices.csv');
	});

	test('handles file directly under workspace root', () => {
		const rel = workspaceRelativeDatasetUri('/ws/prices.csv', '/ws');
		assert.strictEqual(rel, 'prices.csv');
	});

	test('returns null when data file is outside workspace', () => {
		assert.strictEqual(
			workspaceRelativeDatasetUri('/elsewhere/prices.csv', '/ws'),
			null,
		);
	});

	test('returns null when data file equals workspace root', () => {
		// Defensive: relative path of the root against itself is ""; we
		// don't want to write an empty dataset.uri into the draft.
		assert.strictEqual(
			workspaceRelativeDatasetUri('/ws', '/ws'),
			null,
		);
	});

	test('preserves special chars in the filename', () => {
		const rel = workspaceRelativeDatasetUri('/ws/INDEX_BTCUSD, 1D (4).csv', '/ws');
		assert.strictEqual(rel, 'INDEX_BTCUSD, 1D (4).csv');
	});
});

suite('Step D — buildDraftSpecForDataset', () => {
	test('produces a spec that passes validateOrThrow', () => {
		const spec = buildDraftSpecForDataset('data/prices.csv');
		// Use the tagged validator so we can show specific issues on
		// failure rather than just an opaque throw.
		const r = validate(spec);
		assert.strictEqual(
			r.ok,
			true,
			`draft spec must validate cleanly; issues:\n${(r as { ok: false; issues: { path: string; message: string }[] }).issues?.map(i => `  ${i.path}: ${i.message}`).join('\n') ?? 'unknown'}`,
		);
	});

	test('embeds the given dataset URI verbatim', () => {
		const spec = buildDraftSpecForDataset('subdir/foo.csv');
		assert.strictEqual(spec.dataset.uri, 'subdir/foo.csv');
	});

	test('uses the placeholder schema_hash constant', () => {
		const spec = buildDraftSpecForDataset('data/prices.csv');
		assert.strictEqual(spec.dataset.schema_hash, PLACEHOLDER_SCHEMA_HASH);
		// And the placeholder matches the validator's sha256 regex --
		// otherwise the spec wouldn't validate. This is a contract
		// pin: regressions to the placeholder format show up here.
		assert.match(spec.dataset.schema_hash, /^sha256:[0-9a-f]{64}$/);
	});

	test('refuses empty / non-string URI', () => {
		assert.throws(() => buildDraftSpecForDataset(''), /non-empty string/);
		assert.throws(
			() => buildDraftSpecForDataset(undefined as unknown as string),
			/non-empty string/,
		);
	});

	test('defaults to a general/scatter chart with empty encodings', () => {
		// Smoke-test fix (2026-05-11): encodings start EMPTY. The previous
		// placeholder x/y fields named literally 'x' and 'y' broke first
		// render: real datasets never have those column names, so the
		// renderer threw "field 'x' not in column data" before the user
		// saw the column panel. Empty encodings now route through the
		// cartesian-completeness guard ("scatter chart requires encodings.x
		// and encodings.y") which is the actionable empty-state message.
		// Pin: regressions that re-introduce placeholder fields will fail
		// here.
		const spec = buildDraftSpecForDataset('data/prices.csv');
		assert.strictEqual(spec.chart.family, 'general');
		assert.strictEqual(spec.chart.type, 'scatter');
		assert.strictEqual(spec.chart.encodings.x, undefined,
			'draft must NOT prebind x to a placeholder column name');
		assert.strictEqual(spec.chart.encodings.y, undefined,
			'draft must NOT prebind y to a placeholder column name');
	});

	test('provenance carries a fresh generated_at and tool_versions.qviz_schema', () => {
		const before = Date.now();
		const spec = buildDraftSpecForDataset('data/prices.csv');
		const generated = Date.parse(spec.provenance.generated_at);
		const after = Date.now();
		assert.ok(
			generated >= before && generated <= after + 1000,
			`generated_at (${spec.provenance.generated_at}) should be within the test window`,
		);
		assert.strictEqual(spec.provenance.tool_versions.qviz_schema, 1);
		assert.strictEqual(spec.provenance.source, 'user-built');
	});
});
