/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// **Wave N (2026-06-20)** -- unit tests for the vscode-free core of the Quantbook Import command:
// deriveImportFormat (extension -> engine format, LOUD undefined on anything else) and
// collectImportWarnings (the No-Fallbacks unsupported-features report drained from the session
// event ring). The #1 correctness target -- a lossy import is NEVER silent and an unknown
// extension NEVER guesses a format -- is pinned as a deterministic unit suite (no engine, no vscode).

import * as assert from 'assert';

import { collectImportWarnings, deriveImportFormat } from '../src/quantbook/cellGrid/importLogic';
import type { EventJson } from '../src/quantbook/types';

suite('Quantbook import logic', () => {
	suite('deriveImportFormat', () => {
		test('maps .xlsx to xlsx (case-insensitive)', () => {
			assert.strictEqual(deriveImportFormat('/a/b/model.xlsx'), 'xlsx');
			assert.strictEqual(deriveImportFormat('/a/b/MODEL.XLSX'), 'xlsx');
		});

		test('maps .csv to csv (case-insensitive)', () => {
			assert.strictEqual(deriveImportFormat('returns.csv'), 'csv');
			assert.strictEqual(deriveImportFormat('RETURNS.CSV'), 'csv');
		});

		test('returns undefined for any other extension (no silent guess)', () => {
			assert.strictEqual(deriveImportFormat('book.xls'), undefined);
			assert.strictEqual(deriveImportFormat('data.tsv'), undefined);
			assert.strictEqual(deriveImportFormat('notes.txt'), undefined);
			assert.strictEqual(deriveImportFormat('no-extension'), undefined);
			assert.strictEqual(deriveImportFormat('archive.xlsx.bak'), undefined);
		});

		test('does not mistake a substring for the extension', () => {
			// "csvdata.json" ends in json, not csv.
			assert.strictEqual(deriveImportFormat('csvdata.json'), undefined);
			// A directory-like name containing ".xlsx" mid-path but a .csv leaf.
			assert.strictEqual(deriveImportFormat('/x.xlsx/leaf.csv'), 'csv');
		});
	});

	suite('collectImportWarnings', () => {
		function diag(code: string, message: string): EventJson {
			return { kind: 'cell_diagnostic', diagnostic: { severity: 'warning', code, message } };
		}

		test('collects every xlsx_-prefixed cell_diagnostic (features, warnings, formula failures), in order', () => {
			const events: EventJson[] = [
				diag('xlsx_unsupported_feature', 'ConditionalFormatting dropped (3 occurrence(s))'),
				diag('xlsx_unsupported_feature', 'MergedCells dropped (2 occurrence(s))'),
				// A formula the engine could not recompute on import (cached value preserved) is ALSO
				// an `xlsx_`-coded warning and MUST be surfaced -- it is real data-fidelity loss.
				diag('xlsx_formula_recompute_failed', 'Sheet1!A1: =CUBEVALUE(...) could not be recomputed'),
				diag('xlsx_import_warning', 'rels: unresolved relationship'),
			];
			const got = collectImportWarnings(events);
			assert.deepStrictEqual(got, [
				'ConditionalFormatting dropped (3 occurrence(s))',
				'MergedCells dropped (2 occurrence(s))',
				'Sheet1!A1: =CUBEVALUE(...) could not be recomputed',
				'rels: unresolved relationship',
			]);
		});

		test('does not throw on a malformed diagnostic payload (missing code/message)', () => {
			// A wrong-shape event over the napi boundary must be IGNORED, never throw a TypeError --
			// a throw here would be caught by the command and silently downgrade a lossy import to
			// "no warnings" (a No-Fallbacks violation).
			const events = [
				{ kind: 'cell_diagnostic', diagnostic: { severity: 'warning', message: 'no code field' } },
				{ kind: 'cell_diagnostic', diagnostic: { severity: 'warning', code: 'xlsx_unsupported_feature' } }, // no message
				diag('xlsx_unsupported_feature', 'Pivots dropped (1 occurrence(s))'),
			] as unknown as EventJson[];
			const got = collectImportWarnings(events);
			assert.deepStrictEqual(got, ['Pivots dropped (1 occurrence(s))']);
		});

		test('ignores non-import diagnostics and non-diagnostic events', () => {
			const events: EventJson[] = [
				{ kind: 'recalc_progress', op: 1n, done: 1n, total: 1n },
				diag('cell_eval_error', 'ValueError: boom'), // a per-cell error, NOT an import warning
				diag('xlsx_unsupported_feature', 'Pivots dropped (1 occurrence(s))'),
				{ kind: 'full_resync_required' },
				{ kind: 'cell_diagnostic' }, // a cell_diagnostic with no diagnostic payload
			];
			const got = collectImportWarnings(events);
			assert.deepStrictEqual(got, ['Pivots dropped (1 occurrence(s))']);
		});

		test('returns an empty array for a clean import (no warnings)', () => {
			// CSV import emits no unsupported-feature diagnostics.
			assert.deepStrictEqual(collectImportWarnings([]), []);
			assert.deepStrictEqual(collectImportWarnings([{ kind: 'recalc_progress' }]), []);
		});
	});
});
