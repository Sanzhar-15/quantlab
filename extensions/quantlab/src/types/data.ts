/*---------------------------------------------------------------------------------------------
 *  Data file type definitions for QuantLab statistics feature
 *--------------------------------------------------------------------------------------------*/

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
