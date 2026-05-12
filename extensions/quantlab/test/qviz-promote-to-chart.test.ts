/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for Visualise v2 -- Promote to Chart scaffold generator.
 *
 * The generator is a pure function: spec + specUri + workspaceRoot ->
 * { kind: 'ok', scaffoldPath, scaffoldBody } | { kind: 'error', ... }.
 * No vscode dep; tests run under bare mocha.
 *
 * Tests cover:
 *   - Happy paths: timeseries/line, timeseries/area, timeseries/candlestick.
 *   - Refusal paths: general family, missing dataset, empty encodings.
 *   - Idempotency: existing scaffold w/ header overwritable; without header refused.
 *   - Path sanitization: nested spec path -> flat scaffold filename.
 *   - Scaffold body shape: header marker present, source spec path noted,
 *     y-field correctly chosen.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	generatePromoteScaffold,
	PROMOTE_SCAFFOLD_HEADER_MARKER,
	SCAFFOLD_SUBDIR,
} from '../src/qviz/promoteToChart';
import type { QvizSpec } from '../src/qviz/spec';

const NOW = '2026-05-12T00:00:00.000Z';

function makeSpec(overrides: Partial<QvizSpec> = {}): QvizSpec {
	return {
		qviz_version: 1,
		dataset: {
			uri: 'data/aapl.parquet',
			schema_hash: 'sha256:' + 'a'.repeat(64),
			mtime_ns: 1700000000000000000,
		},
		transforms: [],
		chart: {
			family: 'timeseries',
			type: 'line',
			encodings: {
				x: { field: 'time', type: 'temporal' },
				y: { field: 'close', type: 'quantitative' },
			},
		},
		provenance: {
			generated_at: NOW,
			generator: 'test/0.1.0',
			query_hash: 'sha256:' + '0'.repeat(64),
			tool_versions: { qviz_schema: 1 },
		},
		...overrides,
	} as QvizSpec;
}

/** A throwaway workspace dir with a real `data/aapl.parquet` so the
 *  dataset-resolve gate passes. */
function makeWorkspace(): { workspaceRoot: string; specUri: string; cleanup: () => void } {
	const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-promote-test-'));
	fs.mkdirSync(path.join(ws, 'data'));
	fs.writeFileSync(path.join(ws, 'data', 'aapl.parquet'), 'fake-parquet-bytes');
	const specPath = path.join(ws, 'data', 'aapl.qviz.json');
	fs.writeFileSync(specPath, '{}');
	return {
		workspaceRoot: ws,
		specUri: specPath,
		cleanup: () => fs.rmSync(ws, { recursive: true, force: true }),
	};
}

suite('promoteToChart -- generatePromoteScaffold', () => {

	test('timeseries/line spec produces an OK scaffold with the y-field', () => {
		const { workspaceRoot, specUri, cleanup } = makeWorkspace();
		try {
			const r = generatePromoteScaffold(
				makeSpec(), specUri, workspaceRoot,
				{ nowIso: NOW },
			);
			assert.strictEqual(r.kind, 'ok',
				r.kind === 'error' ? `unexpected error: ${r.message}` : '');
			if (r.kind !== 'ok') { return; }
			assert.ok(r.scaffoldBody.includes(PROMOTE_SCAFFOLD_HEADER_MARKER),
				'scaffold must carry the auto-generated header marker');
			assert.ok(r.scaffoldBody.includes('chart.plot(data.close)'),
				`scaffold must plot data.close, got:\n${r.scaffoldBody}`);
			assert.ok(r.scaffoldBody.includes(NOW),
				'scaffold must embed the generation timestamp');
			assert.ok(r.scaffoldPath.includes(SCAFFOLD_SUBDIR),
				`scaffold path must live under ${SCAFFOLD_SUBDIR}, got ${r.scaffoldPath}`);
			assert.ok(r.scaffoldPath.endsWith('.py'),
				`scaffold path must end with .py, got ${r.scaffoldPath}`);
		} finally { cleanup(); }
	});

	test('candlestick spec scaffolds with data.close (single-line projection)', () => {
		const { workspaceRoot, specUri, cleanup } = makeWorkspace();
		try {
			const r = generatePromoteScaffold(
				makeSpec({
					chart: {
						family: 'timeseries',
						type: 'candlestick',
						encodings: {
							ohlcv: {
								time: 'time', open: 'open', high: 'high',
								low: 'low', close: 'close',
							},
						},
					},
				}),
				specUri, workspaceRoot, { nowIso: NOW },
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind !== 'ok') { return; }
			assert.ok(r.scaffoldBody.includes('chart.plot(data.close)'),
				'candlestick scaffold must plot the close field');
			assert.ok(r.scaffoldBody.includes('Original chart type: candlestick'),
				'scaffold should record the source chart type');
		} finally { cleanup(); }
	});

	test('general/scatter spec is rejected (Chart view is OHLCV-only)', () => {
		const { workspaceRoot, specUri, cleanup } = makeWorkspace();
		try {
			const r = generatePromoteScaffold(
				makeSpec({
					chart: {
						family: 'general',
						type: 'scatter',
						encodings: {
							x: { field: 'a', type: 'quantitative' },
							y: { field: 'b', type: 'quantitative' },
						},
					},
				}),
				specUri, workspaceRoot, { nowIso: NOW },
			);
			assert.strictEqual(r.kind, 'error');
			if (r.kind !== 'error') { return; }
			assert.ok(r.message.toLowerCase().includes('timeseries'),
				`error must mention the timeseries-only constraint, got: ${r.message}`);
		} finally { cleanup(); }
	});

	test('missing dataset (file not in workspace) is rejected', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-promote-test-'));
		const specPath = path.join(ws, 'a.qviz.json');
		fs.writeFileSync(specPath, '{}');
		try {
			const r = generatePromoteScaffold(
				makeSpec({ dataset: {
					uri: 'data/missing.parquet',
					schema_hash: 'sha256:' + 'a'.repeat(64),
					mtime_ns: 1,
				} }),
				specPath, ws, { nowIso: NOW },
			);
			assert.strictEqual(r.kind, 'error');
			if (r.kind !== 'error') { return; }
			assert.ok(r.message.toLowerCase().includes('dataset'),
				`error must mention dataset, got: ${r.message}`);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

	test('no plottable encoding (line without y) is rejected', () => {
		const { workspaceRoot, specUri, cleanup } = makeWorkspace();
		try {
			const r = generatePromoteScaffold(
				makeSpec({
					chart: {
						family: 'timeseries',
						type: 'line',
						encodings: {
							x: { field: 'time', type: 'temporal' },
							// no y
						},
					},
				}),
				specUri, workspaceRoot, { nowIso: NOW },
			);
			assert.strictEqual(r.kind, 'error');
			if (r.kind !== 'error') { return; }
			assert.ok(r.message.toLowerCase().includes('encoding')
				|| r.message.toLowerCase().includes('plottable'),
				`error must mention missing encoding, got: ${r.message}`);
		} finally { cleanup(); }
	});

	test('idempotent overwrite when existing scaffold has the auto-generated header', () => {
		const { workspaceRoot, specUri, cleanup } = makeWorkspace();
		try {
			// Stub readExistingFile to return a body that DOES contain the header marker.
			const stubBody = `${PROMOTE_SCAFFOLD_HEADER_MARKER}\n# old content\n`;
			const r = generatePromoteScaffold(
				makeSpec(), specUri, workspaceRoot,
				{
					nowIso: NOW,
					readExistingFile: () => stubBody,
				},
			);
			assert.strictEqual(r.kind, 'ok',
				'overwrite must be permitted when the header marker is intact');
		} finally { cleanup(); }
	});

	test('refuse to overwrite when existing scaffold lacks the header (hand-edited)', () => {
		const { workspaceRoot, specUri, cleanup } = makeWorkspace();
		try {
			const handEditedBody = '# user-authored python file, not the scaffold\nimport ql\n';
			const r = generatePromoteScaffold(
				makeSpec(), specUri, workspaceRoot,
				{
					nowIso: NOW,
					readExistingFile: () => handEditedBody,
				},
			);
			assert.strictEqual(r.kind, 'error');
			if (r.kind !== 'error') { return; }
			assert.ok(r.message.toLowerCase().includes('hand-edited')
				|| r.message.toLowerCase().includes('header'),
				`error must mention hand-edit / header, got: ${r.message}`);
		} finally { cleanup(); }
	});

	test('scaffold path sanitizes nested spec locations (subdir/foo.qviz.json -> subdir__foo.py)', () => {
		const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'qviz-promote-test-'));
		fs.mkdirSync(path.join(ws, 'data'));
		fs.mkdirSync(path.join(ws, 'sub'));
		fs.writeFileSync(path.join(ws, 'data', 'aapl.parquet'), 'x');
		const specPath = path.join(ws, 'sub', 'foo.qviz.json');
		fs.writeFileSync(specPath, '{}');
		try {
			const r = generatePromoteScaffold(
				makeSpec(), specPath, ws, { nowIso: NOW },
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind !== 'ok') { return; }
			const base = path.basename(r.scaffoldPath);
			assert.strictEqual(base, 'sub__foo.py',
				`scaffold filename should be 'sub__foo.py', got '${base}'`);
		} finally {
			fs.rmSync(ws, { recursive: true, force: true });
		}
	});

});
