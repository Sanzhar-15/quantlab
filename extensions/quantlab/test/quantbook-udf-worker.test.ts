/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 6.4-3d Step 5 (2026-05-29) -- IDE-side Python-UDF worker wiring.
 *
 * Pure-logic tests (no native binary, no vscode): the error-code allowlist
 * parity for the 5 new codes, the trust + interpreter-resolution planner
 * (`planUdfWorkerConfig`), and the `Event::CellDiagnostic` -> cell-tooltip
 * bridge (`buildCellDiagnosticMessages` + `attachCellDiagnostics`).
 *
 * These exercise no FFI and no vscode, so they run unconditionally (unlike
 * `quantbook-session.test.ts`, which needs the rebuilt cdylib).
 */

import * as assert from 'assert';
import * as path from 'path';

import { buildHtml } from '../src/quantbook/cellGrid/cellGridHtml';
import { attachCellDiagnostics, buildCellDiagnosticMessages } from '../src/quantbook/cellGrid/cellGridLogic';
import { parseQuantbookError } from '../src/quantbook/session';
import { planUdfWorkerConfig, resolveQuantbookPyDir, UDF_DEFAULT_HANDSHAKE_MS } from '../src/quantbook/udfWorker';
import type { EventJson, QuantbookCellSnapshot } from '../src/quantbook/types';

suite('quantbook 6.4-3d Step 5 -- UDF worker wiring', () => {
	suite('error-code allowlist (the 5 new codes parse)', () => {
		// The Record<Exclude<QuantbookErrorCode,'unknown'>, true> in session.ts is
		// COMPILE-enforced parity; `parseQuantbookError` derives its recognized
		// set from that Record's keys. So a `[code] msg` round-trip proves both
		// the union member AND the Record entry exist for each new code.
		for (const code of [
			'worker_spawn_failed',
			'worker_handshake',
			'worker_untrusted_workspace',
			'invalid_state',
			'session_busy',
		] as const) {
			test(`parseQuantbookError recognizes [${code}]`, () => {
				const info = parseQuantbookError(new Error(`[${code}] something went wrong`));
				assert.strictEqual(info.code, code);
				assert.strictEqual(info.message, 'something went wrong');
			});
		}

		test('an unknown bracket code still falls back to unknown (sanity)', () => {
			const info = parseQuantbookError(new Error('[definitely_not_a_code] x'));
			assert.strictEqual(info.code, 'unknown');
		});
	});

	suite('planUdfWorkerConfig (pure trust + resolution gates)', () => {
		const okPython = { pythonPath: '/usr/bin/python3', source: 'config-quantlab' as const };
		const qpyDir = '/engine/crates/quantbook-py/python';

		test('untrusted workspace -> [worker_untrusted_workspace], no spawn (versionCheck never runs)', () => {
			let versionChecked = false;
			assert.throws(
				() =>
					planUdfWorkerConfig({
						isWorkspaceTrusted: false,
						resolvedPython: okPython,
						quantbookPyDir: qpyDir,
						versionCheck: () => {
							versionChecked = true;
							return { ok: true };
						},
					}),
				/\[worker_untrusted_workspace\]/,
			);
			assert.strictEqual(versionChecked, false, 'must not probe the interpreter when untrusted');
		});

		test('no interpreter resolved -> [worker_spawn_failed] mentioning quantlab.pythonPath', () => {
			assert.throws(
				() =>
					planUdfWorkerConfig({
						isWorkspaceTrusted: true,
						resolvedPython: null,
						quantbookPyDir: qpyDir,
					}),
				/\[worker_spawn_failed\][\s\S]*quantlab\.pythonPath/,
			);
		});

		test('interpreter too old -> [worker_spawn_failed] (version check fails)', () => {
			assert.throws(
				() =>
					planUdfWorkerConfig({
						isWorkspaceTrusted: true,
						resolvedPython: okPython,
						quantbookPyDir: qpyDir,
						versionCheck: () => ({ ok: false, error: 'python 3.8 is below minimum 3.9' }),
					}),
				/\[worker_spawn_failed\][\s\S]*3\.8 is below/,
			);
		});

		test('happy path: config carries python, quantbookPyDir first on PYTHONPATH, default handshake, udfModule', () => {
			const cfg = planUdfWorkerConfig({
				isWorkspaceTrusted: true,
				resolvedPython: okPython,
				quantbookPyDir: qpyDir,
				versionCheck: () => ({ ok: true }),
				udfModule: 'my_udfs',
				extraPythonPath: ['/workspace/udfs'],
			});
			assert.strictEqual(cfg.python, '/usr/bin/python3');
			assert.deepStrictEqual(cfg.pythonpath, [qpyDir, '/workspace/udfs']);
			assert.strictEqual(cfg.pythonpath?.[0], qpyDir, 'engine package dir must be first');
			assert.strictEqual(cfg.udfModule, 'my_udfs');
			assert.strictEqual(cfg.handshakeTimeoutMs, UDF_DEFAULT_HANDSHAKE_MS);
		});

		test('udfModule omitted when not provided (no undefined-valued key); handshake override honored', () => {
			const cfg = planUdfWorkerConfig({
				isWorkspaceTrusted: true,
				resolvedPython: okPython,
				quantbookPyDir: qpyDir,
				versionCheck: () => ({ ok: true }),
				handshakeTimeoutMs: 12345,
			});
			assert.ok(
				!Object.prototype.hasOwnProperty.call(cfg, 'udfModule'),
				'udfModule key must be ABSENT, not undefined (napi-rs)',
			);
			assert.strictEqual(cfg.handshakeTimeoutMs, 12345);
			assert.deepStrictEqual(cfg.pythonpath, [qpyDir]);
		});
	});

	suite('resolveQuantbookPyDir (engine python package dir)', () => {
		// Save/restore the two env vars the resolver consults.
		let savedPyDir: string | undefined;
		let savedEnginePath: string | undefined;
		setup(() => {
			savedPyDir = process.env.QUANTBOOK_PY_DIR;
			savedEnginePath = process.env.QUANTBOOK_ENGINE_PATH;
		});
		teardown(() => {
			if (savedPyDir === undefined) { delete process.env.QUANTBOOK_PY_DIR; } else { process.env.QUANTBOOK_PY_DIR = savedPyDir; }
			if (savedEnginePath === undefined) { delete process.env.QUANTBOOK_ENGINE_PATH; } else { process.env.QUANTBOOK_ENGINE_PATH = savedEnginePath; }
		});

		test('QUANTBOOK_PY_DIR override wins verbatim', () => {
			process.env.QUANTBOOK_PY_DIR = '/opt/quantlab/py';
			assert.strictEqual(resolveQuantbookPyDir(), '/opt/quantlab/py');
		});

		test('derives from QUANTBOOK_ENGINE_PATH under the canonical layout', () => {
			delete process.env.QUANTBOOK_PY_DIR;
			process.env.QUANTBOOK_ENGINE_PATH =
				'/foo/quantbook-engine/target/release/libql_bindings_node.dylib';
			assert.strictEqual(
				resolveQuantbookPyDir(),
				path.join('/foo/quantbook-engine', 'crates', 'quantbook-py', 'python'),
			);
		});
	});

	suite('buildCellDiagnosticMessages (event -> per-cell message map)', () => {
		const events: EventJson[] = [
			{ kind: 'recalc_progress', op: 1n, done: 0n, total: 1n }, // ignored
			{
				kind: 'cell_diagnostic',
				diagnostic: { addr: { sheet: 0, row: 0, col: 1 }, severity: 'error', code: 'udf_no_worker', message: 'no worker' },
			},
			{
				// other sheet -> ignored when filtering sheet 0
				kind: 'cell_diagnostic',
				diagnostic: { addr: { sheet: 1, row: 0, col: 1 }, severity: 'error', code: 'udf_raised', message: 'other sheet' },
			},
			{
				// later diagnostic for the SAME cell wins
				kind: 'cell_diagnostic',
				diagnostic: { addr: { sheet: 0, row: 0, col: 1 }, severity: 'error', code: 'udf_raised', message: 'ValueError: boom' },
			},
			{
				// workbook-level (no addr) -> ignored
				kind: 'cell_diagnostic',
				diagnostic: { severity: 'warning', code: 'something', message: 'no addr' },
			},
		];

		test('filters by sheet, ignores non-diagnostic + addr-less, last-wins', () => {
			const m = buildCellDiagnosticMessages(events, 0);
			assert.strictEqual(m.size, 1);
			assert.strictEqual(m.get('0,1'), 'ValueError: boom');
		});

		test('a different sheet sees only its own diagnostics', () => {
			const m = buildCellDiagnosticMessages(events, 1);
			assert.strictEqual(m.size, 1);
			assert.strictEqual(m.get('0,1'), 'other sheet');
		});
	});

	suite('attachCellDiagnostics (merge onto error-valued cells only)', () => {
		const base: QuantbookCellSnapshot = {
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 0, value: { kind: 'number', value: 42 } },
				{ row: 0, col: 1, value: { kind: 'error', value: '#CALC!' } },
			],
		};

		test('attaches the message to the error cell only; number cell untouched', () => {
			const msgs = new Map<string, string>([
				['0,0', 'stale message for a recovered cell'],
				['0,1', 'no Python worker is configured for this session'],
			]);
			const out = attachCellDiagnostics(base, msgs);
			const errCell = out.entries.find(e => e.col === 1)!;
			const numCell = out.entries.find(e => e.col === 0)!;
			assert.strictEqual(errCell.diagnostic, 'no Python worker is configured for this session');
			assert.ok(
				!Object.prototype.hasOwnProperty.call(numCell, 'diagnostic'),
				'a non-error (recovered) cell drops the stale tooltip',
			);
		});

		test('empty message map returns the same snapshot reference (no-op)', () => {
			const out = attachCellDiagnostics(base, new Map());
			assert.strictEqual(out, base);
		});

		test('does not mutate the input snapshot', () => {
			const msgs = new Map<string, string>([['0,1', 'boom']]);
			attachCellDiagnostics(base, msgs);
			const errCell = base.entries.find(e => e.col === 1)!;
			assert.ok(
				!Object.prototype.hasOwnProperty.call(errCell, 'diagnostic'),
				'input must be left unchanged',
			);
		});

		test('STRIPS a stale diagnostic on a recovered or no-longer-covered cell (audit-fix)', () => {
			// Simulate a previously-attached snapshot fed back in with an EMPTY
			// current map: both stale tooltips must be dropped.
			const stale: QuantbookCellSnapshot = {
				snapshot_format_version: 1,
				sheet: 0,
				entries: [
					{ row: 0, col: 0, value: { kind: 'number', value: 7 }, diagnostic: 'old: no worker' },
					{ row: 0, col: 1, value: { kind: 'error', value: '#CALC!' }, diagnostic: 'old: no worker' },
				],
			};
			const out = attachCellDiagnostics(stale, new Map());
			const recovered = out.entries.find(e => e.col === 0)!;
			const stillErr = out.entries.find(e => e.col === 1)!;
			assert.ok(
				!Object.prototype.hasOwnProperty.call(recovered, 'diagnostic'),
				'a cell that recovered to a value drops its stale tooltip',
			);
			assert.ok(
				!Object.prototype.hasOwnProperty.call(stillErr, 'diagnostic'),
				'an error cell with no CURRENT message drops its stale tooltip',
			);
		});

		test('idempotent: re-attaching with a changed message REPLACES, never accumulates', () => {
			const first = attachCellDiagnostics(base, new Map([['0,1', 'msg A']]));
			const second = attachCellDiagnostics(first, new Map([['0,1', 'msg B']]));
			const c = second.entries.find(e => e.col === 1)!;
			assert.strictEqual(c.diagnostic, 'msg B', 'latest message wins, no stale carryover');
		});
	});

	suite('buildHtml renders the diagnostic as a title= tooltip (server + client mirror)', () => {
		const snapWithDiag: QuantbookCellSnapshot = {
			snapshot_format_version: 1,
			sheet: 0,
			entries: [
				{ row: 0, col: 1, value: { kind: 'error', value: '#CALC!' }, diagnostic: 'no Python worker configured' },
			],
		};

		test('server-side render emits an escaped title= for a diagnostic cell, keeping the #CALC! text', () => {
			const html = buildHtml(snapWithDiag, {});
			assert.ok(html.includes('title="no Python worker configured"'), 'server render carries the tooltip');
			assert.ok(html.includes('#CALC!'), 'the error sigil text is preserved');
		});

		test('client-side renderRowsClient mirror reads e.diagnostic (survives scroll repaints)', () => {
			// The nonce path injects the client virtualization script; the audit-fix
			// added the titleAttr mirror so the tooltip is not lost on repaint.
			const html = buildHtml(snapWithDiag, { nonce: 'test-nonce' });
			assert.ok(html.includes('e.diagnostic'), 'client renderRowsClient references e.diagnostic');
			assert.ok(html.includes('titleAttr'), 'client render builds a titleAttr');
		});
	});
});
