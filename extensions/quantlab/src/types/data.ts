/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Data file type definitions for QuantLab statistics feature

/*
 * Megaudit-2 A4-M6: this allowlist (csv/tsv/parquet/xlsx) intentionally
 * DIFFERS from the qviz daemon's allowlist (parquet/csv/tsv) in
 *   - src/qviz/persist.ts (`ALLOWED_EXTENSIONS`)
 *   - python/qviz/security.py (`ALLOWED_EXTENSIONS`)
 *
 * The two cover different surfaces:
 *   - This file: the DataView Manager + stats UI, which renders xlsx
 *     using a JS xlsx library inside the extension host.
 *   - qviz allowlist: the Python daemon's pyarrow reader, which has
 *     NO xlsx support. tsv is supported there via the pyarrow CSV
 *     reader with a tab delimiter.
 *
 * Megaudit 2026-06-11 (H40): 'tsv' added here so switchToVisualise and
 * the `quantlab.isDataFile` context key accept TSV (the qviz daemon
 * supports it end-to-end). The Action and Stats views do NOT support
 * TSV; DataViewManager.openDataAction/openStatsTest refuse it with an
 * explicit message instead of opening a view that misparses the file.
 *
 * If you're adding a new format, update BOTH places where applicable
 * and the daemon's `reader.py`. Do NOT silently add xlsx to qviz
 * without daemon support: the qviz UI will accept the spec, then the
 * first schema() RPC will reject it with `extension-not-allowed` and
 * the user will see a confusing error.
 */

export type DataFileType = 'csv' | 'tsv' | 'parquet' | 'xlsx';

export interface DataFileInfo {
	path: string;
	type: DataFileType;
	columns: ColumnInfo[];
	rowCount: number;
	dateRange?: { start: Date; end: Date };
}

export type ColumnDType = 'float64' | 'int64' | 'datetime64' | 'object' | 'bool';

export interface ColumnInfo {
	name: string;
	dtype: ColumnDType;
	nullCount: number;
	uniqueCount: number;
	min?: number;
	max?: number;
	sampleValues?: unknown[];
}

export function isDataFileExtension(ext: string): ext is DataFileType {
	return ext === 'csv' || ext === 'tsv' || ext === 'parquet' || ext === 'xlsx';
}

export function getDataFileType(filePath: string): DataFileType | null {
	const ext = filePath.toLowerCase().split('.').pop();
	if (ext && isDataFileExtension(ext)) {
		return ext;
	}
	return null;
}
