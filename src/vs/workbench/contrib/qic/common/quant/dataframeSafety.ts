/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QicPythonBridge, DataFramePreview } from './qicPythonBridge.js';

const DEFAULT_MAX_ROWS = 50;
const DEFAULT_MAX_COLUMNS = 50;

/**
 * Safe DataFrame preview — prevents OOM on large files.
 *
 * AUDIT FIX III-QI10 (LOW): Delegates file reading to existing data services:
 * - Parquet: Routes through engine's parquet_loader via IPC
 * - CSV: Routes through engine's csv_loader via IPC
 * - Arrow: Direct read via TypeScript (apache-arrow npm)
 *
 * All previews go through QicPythonBridge to the existing engine daemon.
 */
export class DataFrameSafety {

	constructor(
		private readonly bridge: QicPythonBridge,
	) {}

	/**
	 * Preview a DataFrame without loading it fully into memory.
	 * Uses the QicPythonBridge (existing engine daemon) to read only the preview slice.
	 */
	async preview(
		filePath: string,
		options?: { maxRows?: number; maxColumns?: number; format?: 'csv' | 'parquet' | 'feather' },
	): Promise<DataFramePreview> {
		const maxRows = options?.maxRows ?? DEFAULT_MAX_ROWS;
		const maxColumns = options?.maxColumns ?? DEFAULT_MAX_COLUMNS;
		const format = options?.format ?? this.detectFormat(filePath);

		return this.bridge.previewDataFrame(filePath, {
			maxRows,
			maxColumns,
			format,
		});
	}

	/**
	 * Get summary statistics for a DataFrame column.
	 */
	async columnStats(filePath: string, columnName: string): Promise<Record<string, unknown>> {
		return this.bridge.call('qic.column_stats', { path: filePath, column: columnName });
	}

	/**
	 * Get shape without loading data.
	 */
	async shape(filePath: string): Promise<[number, number]> {
		const preview = await this.bridge.previewDataFrame(filePath, { maxRows: 0, maxColumns: 0 });
		return preview.shape;
	}

	/**
	 * Detect file format from extension.
	 */
	private detectFormat(filePath: string): 'csv' | 'parquet' | 'feather' {
		const lower = filePath.toLowerCase();
		if (lower.endsWith('.parquet') || lower.endsWith('.pq')) {
			return 'parquet';
		}
		if (lower.endsWith('.feather') || lower.endsWith('.arrow') || lower.endsWith('.ipc')) {
			return 'feather';
		}
		return 'csv';
	}
}
