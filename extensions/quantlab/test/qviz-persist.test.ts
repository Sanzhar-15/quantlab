/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for `persist.ts` — Phase 5 step 5.C.1.
 *
 * Exercises:
 *   - Workspace-relative path resolution.
 *   - Failure modes: no-workspace, absolute-uri, path-escape (..),
 *     symlink-escape, missing, extension-not-allowed, not-file.
 *   - `refreshDatasetProvenance` produces a fresh spec with updated
 *     dataset hash + provenance.generated_at.
 *
 * Tests use a temp directory rather than mocks so symlink semantics
 * (which differ across platforms) are exercised against the real fs.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	resolveDatasetPath, refreshDatasetProvenance,
} from '../src/qviz/persist';
import type { QvizSpec } from '../src/qviz/spec';

let workspaceRoot: string;

function setupWorkspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-persist-'));
	fs.mkdirSync(path.join(root, 'data'), { recursive: true });
	return root;
}

function rmrf(p: string): void {
	try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* tmp cleanup */ }
}

function makeFile(rel: string, content = 'x'): string {
	const abs = path.join(workspaceRoot, rel);
	fs.mkdirSync(path.dirname(abs), { recursive: true });
	fs.writeFileSync(abs, content);
	return abs;
}

suite('persist.resolveDatasetPath', () => {

	suiteSetup(() => { workspaceRoot = setupWorkspace(); });
	suiteTeardown(() => { rmrf(workspaceRoot); });

	test('happy path: workspace-relative parquet resolves to absolute', () => {
		makeFile('data/x.parquet');
		const r = resolveDatasetPath('data/x.parquet', workspaceRoot);
		assert.strictEqual(r.kind, 'ok');
		if (r.kind !== 'ok') { return; }
		assert.ok(path.isAbsolute(r.absPath));
		assert.ok(fs.existsSync(r.absPath));
		assert.ok(r.size > 0);
		assert.ok(typeof r.mtime_ns === 'number' && r.mtime_ns > 0);
	});

	test('no-workspace: rejects null workspaceRoot', () => {
		const r = resolveDatasetPath('data/x.parquet', null);
		assert.strictEqual(r.kind, 'no-workspace');
	});

	test('absolute-uri: rejects /abs/path', () => {
		makeFile('data/x.parquet');
		const r = resolveDatasetPath('/etc/passwd', workspaceRoot);
		assert.strictEqual(r.kind, 'absolute-uri');
	});

	test('path-escape: rejects ../escape', () => {
		const r = resolveDatasetPath('../etc/passwd', workspaceRoot);
		assert.strictEqual(r.kind, 'path-escape');
	});

	test('path-escape: rejects data/../../escape', () => {
		const r = resolveDatasetPath('data/../../etc/passwd', workspaceRoot);
		assert.strictEqual(r.kind, 'path-escape');
	});

	test('extension-not-allowed: rejects .json', () => {
		makeFile('data/something.json');
		const r = resolveDatasetPath('data/something.json', workspaceRoot);
		assert.strictEqual(r.kind, 'extension-not-allowed');
		if (r.kind !== 'extension-not-allowed') { return; }
		assert.strictEqual(r.extension, '.json');
	});

	test('extension-not-allowed: rejects no-extension', () => {
		makeFile('data/no-ext');
		const r = resolveDatasetPath('data/no-ext', workspaceRoot);
		assert.strictEqual(r.kind, 'extension-not-allowed');
	});

	test('extension-not-allowed: rejects .xlsx (daemon reader does not support it)', () => {
		// Step C megaudit C13: prior allowlist included xlsx but the
		// daemon's reader raises NotImplementedError. Saving a spec
		// with an xlsx dataset would let the user proceed past the
		// extension boundary then fail at first daemon op. Reject here.
		makeFile('data/file.xlsx');
		const r = resolveDatasetPath('data/file.xlsx', workspaceRoot);
		assert.strictEqual(r.kind, 'extension-not-allowed');
	});

	test('extension allowlist: accepts parquet, csv, tsv (matches daemon reader)', () => {
		for (const ext of ['parquet', 'csv', 'tsv']) {
			makeFile(`data/file.${ext}`);
			const r = resolveDatasetPath(`data/file.${ext}`, workspaceRoot);
			assert.strictEqual(r.kind, 'ok', `expected ok for .${ext}, got ${r.kind}`);
		}
	});

	test('missing: nonexistent file is structured-rejected', () => {
		const r = resolveDatasetPath('data/does-not-exist.parquet', workspaceRoot);
		assert.strictEqual(r.kind, 'missing');
	});

	test('symlink-escape: symlink target outside workspace is rejected', function () {
		if (process.platform === 'win32') { this.skip(); return; }
		// Create a target outside the workspace.
		const outsideTarget = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-outside-'));
		try {
			const outsideFile = path.join(outsideTarget, 'secret.parquet');
			fs.writeFileSync(outsideFile, 'secret');
			// Symlink inside workspace pointing at the outside file.
			const linkPath = path.join(workspaceRoot, 'data', 'escape.parquet');
			try { fs.unlinkSync(linkPath); } catch { /* may not exist */ }
			fs.symlinkSync(outsideFile, linkPath);
			const r = resolveDatasetPath('data/escape.parquet', workspaceRoot);
			assert.strictEqual(r.kind, 'symlink-escape',
				`expected symlink-escape, got ${r.kind}`);
		} finally {
			rmrf(outsideTarget);
		}
	});

	test('not-file: a directory is rejected', () => {
		fs.mkdirSync(path.join(workspaceRoot, 'data', 'oops.parquet'), { recursive: true });
		const r = resolveDatasetPath('data/oops.parquet', workspaceRoot);
		// realpath succeeds but stat says it's a directory.
		assert.strictEqual(r.kind, 'not-file');
	});

	test('empty-uri: rejected with structured error (not extension-not-allowed)', () => {
		// Step C megaudit P-Minor: prior code reported empty-URI as
		// extension-not-allowed which was misleading.
		const r = resolveDatasetPath('', workspaceRoot);
		assert.strictEqual(r.kind, 'empty-uri');
	});

	test('absolute-uri: rejects Windows drive-letter paths even on POSIX', () => {
		// Step C megaudit P-Major: POSIX path.isAbsolute doesn't catch
		// `C:\...` so a Windows-style absolute path could slip through
		// the gate on POSIX hosts.
		const r = resolveDatasetPath('C:\\Users\\victim\\file.parquet', workspaceRoot);
		assert.strictEqual(r.kind, 'absolute-uri');
	});

	test('absolute-uri: rejects UNC paths (\\\\server\\share)', () => {
		const r = resolveDatasetPath('\\\\server\\share\\file.parquet', workspaceRoot);
		assert.strictEqual(r.kind, 'absolute-uri');
	});

	test('dangling-symlink: symlink to non-existent target is reported as dangling', function () {
		if (process.platform === 'win32') { this.skip(); return; }
		// Step C megaudit P-Minor: prior code reported dangling symlinks
		// as plain `missing`, hiding the symlink dimension.
		const linkPath = path.join(workspaceRoot, 'data', 'dangling.parquet');
		try { fs.unlinkSync(linkPath); } catch { /* may not exist */ }
		fs.symlinkSync('/nonexistent/target.parquet', linkPath);
		const r = resolveDatasetPath('data/dangling.parquet', workspaceRoot);
		assert.strictEqual(r.kind, 'dangling-symlink',
			`expected dangling-symlink for symlink to nonexistent target, got ${r.kind}`);
	});

});

suite('persist.refreshDatasetProvenance', () => {

	function spec(): QvizSpec {
		return {
			qviz_version: 1,
			dataset: {
				uri: 'data/x.parquet',
				schema_hash: 'sha256:' + 'a'.repeat(64),
				mtime_ns: 1000,
			},
			transforms: [],
			chart: {
				family: 'general', type: 'scatter',
				encodings: {
					x: { field: 'a', type: 'quantitative' },
					y: { field: 'b', type: 'quantitative' },
				},
			},
			provenance: {
				generated_at: '2026-04-01T00:00:00Z',
				generator: 'test', query_hash: 'sha256:0',
				tool_versions: { qviz_schema: 1 },
				source: 'user-built',
			},
		};
	}

	test('updates schema_hash + mtime + generated_at + query_hash sentinel; preserves identity', () => {
		const original = spec();
		const newHash = 'sha256:' + 'b'.repeat(64);
		const updated = refreshDatasetProvenance(original, {
			newSchemaHash: newHash,
			newMtimeNs: 2000,
			newRowCount: 500,
			nowIso: '2026-05-10T00:00:00Z',
		});
		assert.strictEqual(updated.dataset.schema_hash, newHash);
		assert.strictEqual(updated.dataset.mtime_ns, 2000);
		assert.strictEqual(updated.dataset.row_count, 500);
		assert.strictEqual(updated.provenance.generated_at, '2026-05-10T00:00:00Z');
		// Step C megaudit P3: query_hash is RESET because the cached
		// query plan was keyed against the old schema.
		assert.strictEqual(updated.provenance.query_hash, 'sha256:' + '0'.repeat(64));
		// Identity preserved.
		assert.strictEqual(updated.dataset.uri, original.dataset.uri);
		assert.strictEqual(updated.provenance.generator, original.provenance.generator);
		assert.strictEqual(updated.provenance.source, original.provenance.source);
		assert.strictEqual(updated.qviz_version, 1);
		assert.deepStrictEqual(updated.chart.encodings, original.chart.encodings);
	});

	test('newRowCount === null drops dataset.row_count entirely', () => {
		const original = spec();
		const updated = refreshDatasetProvenance(original, {
			newSchemaHash: 'sha256:' + 'b'.repeat(64),
			newMtimeNs: 2000,
			newRowCount: null,
			nowIso: '2026-05-10T00:00:00Z',
		});
		assert.strictEqual(updated.dataset.row_count, undefined);
	});

	test('newRowCount omitted drops dataset.row_count entirely', () => {
		const original = spec();
		const updated = refreshDatasetProvenance(original, {
			newSchemaHash: 'sha256:' + 'b'.repeat(64),
			newMtimeNs: 2000,
			nowIso: '2026-05-10T00:00:00Z',
		});
		assert.strictEqual(updated.dataset.row_count, undefined);
	});

	test('original spec is not mutated', () => {
		const original = spec();
		const originalHash = original.dataset.schema_hash;
		const originalGenAt = original.provenance.generated_at;
		const originalQH = original.provenance.query_hash;
		refreshDatasetProvenance(original, {
			newSchemaHash: 'sha256:' + 'b'.repeat(64),
			newMtimeNs: 2000,
			nowIso: '2026-05-10T00:00:00Z',
		});
		assert.strictEqual(original.dataset.schema_hash, originalHash);
		assert.strictEqual(original.provenance.generated_at, originalGenAt);
		assert.strictEqual(original.provenance.query_hash, originalQH);
	});

});
