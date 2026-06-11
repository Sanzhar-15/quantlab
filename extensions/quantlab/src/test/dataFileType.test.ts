/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Megaudit 2026-06-11 (H40): TSV is a first-class data file for the
// Visualise routing surface. DataViewManager.getDataFileType and the
// types/data.ts helpers must agree, and the action/stats paths must
// refuse TSV explicitly (those views cannot parse it).

import 'mocha';

import * as assert from 'assert';
import { installVscodeShim } from '../../test/helpers/vscode-shim';
installVscodeShim();
import * as vscode from 'vscode';
import { DataViewManager } from '../views/DataViewManager';
import { getDataFileType, isDataFileExtension } from '../types/data';

suite('DataFileType - TSV support (H40)', () => {

	test('DataViewManager.getDataFileType recognises every supported extension', () => {
		const mgr = DataViewManager.getInstance();
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/a.csv')), 'csv');
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/a.tsv')), 'tsv');
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/a.parquet')), 'parquet');
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/a.xlsx')), 'xlsx');
	});

	test('DataViewManager.getDataFileType is case-insensitive and rejects non-data files', () => {
		const mgr = DataViewManager.getInstance();
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/A.TSV')), 'tsv');
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/a.txt')), null);
		assert.strictEqual(mgr.getDataFileType(vscode.Uri.file('/w/a.py')), null);
	});

	test('DataViewManager.isDataFile accepts .tsv', () => {
		const mgr = DataViewManager.getInstance();
		assert.strictEqual(mgr.isDataFile(vscode.Uri.file('/w/prices.tsv')), true);
	});

	test('types/data.ts helpers agree with DataViewManager on tsv', () => {
		assert.strictEqual(isDataFileExtension('tsv'), true);
		assert.strictEqual(getDataFileType('/w/prices.tsv'), 'tsv');
		assert.strictEqual(getDataFileType('/w/prices.txt'), null);
	});
});
