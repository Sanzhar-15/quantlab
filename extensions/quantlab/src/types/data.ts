/*---------------------------------------------------------------------------------------------
 *  Data file type definitions for QuantLab statistics feature
 *--------------------------------------------------------------------------------------------*/

/*
 * Megaudit-2 A4-M6: this allowlist (csv/parquet/xlsx) intentionally
 * DIFFERS from the qviz daemon's allowlist (parquet/csv/tsv) in
 *   - src/qviz/persist.ts (`ALLOWED_EXTENSIONS`)
 *   - python/qviz/security.py (`ALLOWED_EXTENSIONS`)
 *
 * The two cover different surfaces:
 *   - This file: the DataView Manager + stats UI, which renders xlsx
 *     using a JS xlsx library inside the extension host.
 *   - qviz allowlist: the Python daemon's pyarrow reader, which has
 *     NO xlsx support. tsv is supported here only via the pyarrow CSV
 *     reader with a tab delimiter.
 *
 * If you're adding a new format, update BOTH places where applicable
 * and the daemon's `reader.py`. Do NOT silently add xlsx to qviz
 * without daemon support: the qviz UI will accept the spec, then the
 * first schema() RPC will reject it with `extension-not-allowed` and
 * the user will see a confusing error.
 */

export type DataFileType = 'csv' | 'parquet' | 'xlsx';

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
    return ext === 'csv' || ext === 'parquet' || ext === 'xlsx';
}

export function getDataFileType(filePath: string): DataFileType | null {
    const ext = filePath.toLowerCase().split('.').pop();
    if (ext && isDataFileExtension(ext)) {
        return ext;
    }
    return null;
}
