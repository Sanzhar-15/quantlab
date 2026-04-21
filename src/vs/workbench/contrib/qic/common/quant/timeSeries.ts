/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { QicPythonBridge, FrequencyInfo } from './qicPythonBridge.js';

export interface TimeSeriesInfo {
	isTimeSeries: boolean;
	frequency?: 'tick' | 'second' | 'minute' | 'hourly' | 'daily' | 'weekly' | 'monthly';
	dateColumn?: string;
	gaps: Array<{ start: string; end: string; count: number }>;
	outliers: Array<{ index: number; value: number; zscore: number }>;
	warnings: string[];
}

// Common date/time column name patterns
const DATE_COLUMN_PATTERNS = [
	/^date$/i,
	/^datetime$/i,
	/^timestamp$/i,
	/^time$/i,
	/^created_at$/i,
	/^updated_at$/i,
	/^trade_date$/i,
	/^bar_time$/i,
	/^index$/i,
];

// ISO 8601 date pattern
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}:\d{2})?/;

/**
 * Time series detection and analysis.
 *
 * Combines local heuristics (column name matching, date parsing)
 * with engine daemon analysis (frequency detection, stationarity, outliers).
 */
export class TimeSeriesDetector {

	constructor(
		private readonly bridge: QicPythonBridge,
	) {}

	/**
	 * Detect time series characteristics in data.
	 * First tries local heuristics, then delegates to engine daemon for deeper analysis.
	 */
	async analyze(filePath: string): Promise<TimeSeriesInfo> {
		const warnings: string[] = [];

		try {
			// Get preview to detect date columns
			const preview = await this.bridge.previewDataFrame(filePath, {
				maxRows: 100,
				maxColumns: 50,
			});

			// Detect date column
			const dateColumn = this.detectDateColumn(preview.columns, preview.head);

			if (!dateColumn) {
				return {
					isTimeSeries: false,
					gaps: [],
					outliers: [],
					warnings: ['No date/time column detected'],
				};
			}

			// Extract timestamps for frequency detection
			const timestamps = preview.head
				.map(row => String(row[dateColumn] ?? ''))
				.filter(t => t.length > 0);

			if (timestamps.length < 3) {
				return {
					isTimeSeries: true,
					dateColumn,
					gaps: [],
					outliers: [],
					warnings: ['Too few rows for frequency detection'],
				};
			}

			// Delegate to engine daemon for frequency detection
			let frequencyInfo: FrequencyInfo | null = null;
			try {
				frequencyInfo = await this.bridge.detectFrequency(timestamps);
			} catch {
				warnings.push('Frequency detection unavailable (engine daemon not connected)');
			}

			// Map detected frequency to our enum
			const frequency = frequencyInfo ? this.mapFrequency(frequencyInfo.detected) : undefined;

			// Detect outliers via engine daemon
			let outliers: Array<{ index: number; value: number; zscore: number }> = [];
			const numericColumns = preview.columns.filter(c =>
				c.dtype.includes('float') || c.dtype.includes('int') || c.dtype === 'number'
			);

			if (numericColumns.length > 0) {
				try {
					const values = preview.head
						.map(row => Number(row[numericColumns[0].name]))
						.filter(v => !isNaN(v));

					if (values.length > 10) {
						const analysis = await this.bridge.analyzeTimeSeries(values, frequency);
						outliers = analysis.outliers;
					}
				} catch {
					warnings.push('Outlier detection unavailable');
				}
			}

			return {
				isTimeSeries: true,
				frequency,
				dateColumn,
				gaps: frequencyInfo?.gaps ?? [],
				outliers,
				warnings,
			};
		} catch (err) {
			return {
				isTimeSeries: false,
				gaps: [],
				outliers: [],
				warnings: [`Analysis failed: ${err instanceof Error ? err.message : String(err)}`],
			};
		}
	}

	/**
	 * Detect the date column from column names and sample data.
	 */
	private detectDateColumn(
		columns: Array<{ name: string; dtype: string }>,
		sampleRows: Record<string, unknown>[],
	): string | undefined {
		// Strategy 1: Match column name patterns
		for (const col of columns) {
			for (const pattern of DATE_COLUMN_PATTERNS) {
				if (pattern.test(col.name)) {
					return col.name;
				}
			}
		}

		// Strategy 2: Check dtype for datetime types
		for (const col of columns) {
			if (col.dtype.includes('datetime') || col.dtype.includes('Timestamp')) {
				return col.name;
			}
		}

		// Strategy 3: Check first row values for ISO date format
		if (sampleRows.length > 0) {
			for (const col of columns) {
				const value = String(sampleRows[0][col.name] ?? '');
				if (ISO_DATE_REGEX.test(value)) {
					return col.name;
				}
			}
		}

		return undefined;
	}

	/**
	 * Map detected frequency string to our enum values.
	 */
	private mapFrequency(detected: string): TimeSeriesInfo['frequency'] {
		const lower = detected.toLowerCase();
		if (lower.includes('tick')) { return 'tick'; }
		if (lower.includes('second') || lower === 's' || lower === '1s') { return 'second'; }
		if (lower.includes('minute') || lower === 'min' || lower === 't' || lower === '1min') { return 'minute'; }
		if (lower.includes('hour') || lower === 'h' || lower === '1h') { return 'hourly'; }
		if (lower.includes('day') || lower === 'd' || lower === '1d' || lower.includes('daily') || lower === 'b') { return 'daily'; }
		if (lower.includes('week') || lower === 'w') { return 'weekly'; }
		if (lower.includes('month') || lower === 'm' || lower === 'ms') { return 'monthly'; }
		return undefined;
	}
}
