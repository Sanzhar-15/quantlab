/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ChartDateRange, OhlcvBar } from '../../types/chart';
import { Timeframe, toServerTimeframe } from '../../types/market';
import { ServerApiClient, ServerBar, ServerTimeframe } from '../server/ServerApiClient';

const FILE_READ_MAX_RETRIES = 3;
const FILE_READ_RETRY_DELAY_MS = 100;

interface MarketDataMeta {
	source: 'csv' | 'server';
	effectiveTimeframe: Timeframe;
	warning?: string;
	symbol?: string;
}

export interface MarketDataResult {
	requestId: number;
	data: OhlcvBar[];
	meta: MarketDataMeta;
}

/**
 * Market data access for the extension.
 *
 * DT-3 (QL-DATA): this service holds NO market-data cache -- no server-bars
 * cache, no file-bars cache, no in-flight dedupe. The one bars cache lives in
 * the host's main data module; every call here reads through to the transport
 * (server) or the file (local CSV).
 */
export class DataService {
	private static instance: DataService | undefined;
	private requestId = 0;
	private disposed = false;

	static getInstance(): DataService {
		if (!DataService.instance) {
			DataService.instance = new DataService();
		}
		return DataService.instance;
	}

	/**
	 * Disposes the instance. It holds no data to release (DT-3).
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
	}

	/**
	 * Resets the singleton instance. Primarily for testing.
	 */
	static resetInstance(): void {
		if (DataService.instance) {
			DataService.instance.dispose();
			DataService.instance = undefined;
		}
	}

	async getOHLCVFromFile(
		filePath: string,
		range?: ChartDateRange,
		token?: vscode.CancellationToken
	): Promise<MarketDataResult> {
		const requestId = ++this.requestId;
		if (token?.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		// H12: the existence check MUST precede validateWorkspacePath --
		// fs.realpathSync.native inside it throws a raw ENOENT for missing
		// paths, masking the friendly message below.
		if (!fs.existsSync(filePath)) {
			throw new Error(`File not found: ${filePath}`);
		}

		// SECURITY: Validate file is within workspace boundaries
		this.validateWorkspacePath(filePath);

		const ext = path.extname(filePath).toLowerCase();

		let data: OhlcvBar[];
		if (ext === '.csv') {
			data = await this.loadCsvFile(filePath, token);
		} else if (ext === '.parquet') {
			data = await this.loadParquetFile(filePath, token);
		} else {
			throw new Error(`Unsupported file format: ${ext}. Only .csv and .parquet files are supported.`);
		}

		// Check cancellation after file load
		if (token?.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		if (!data.length) {
			throw new Error(`No OHLCV data could be parsed from: ${path.basename(filePath)}`);
		}

		const effectiveTimeframe = this.inferTimeframe(data);
		const filtered = this.filterByRange(data, range);

		const meta: MarketDataMeta = { source: 'csv', effectiveTimeframe };

		return { requestId, data: filtered, meta };
	}

	/**
	 * Validate that a file path is within workspace boundaries.
	 * SECURITY: Prevents path traversal attacks and unauthorized file access.
	 *
	 * @throws Error if path is outside workspace or contains suspicious patterns
	 */
	private validateWorkspacePath(filePath: string): void {
		// Resolve to absolute path and follow symlinks
		const resolvedPath = fs.realpathSync.native(filePath);

		// Get workspace roots
		const workspaceFolders = vscode.workspace.workspaceFolders;
		if (!workspaceFolders || workspaceFolders.length === 0) {
			// No workspace open - allow any file (VS Code handles security)
			return;
		}

		// Check if path is within any workspace folder
		const isWithinWorkspace = workspaceFolders.some(folder => {
			const workspaceRoot = folder.uri.fsPath;
			const normalizedPath = path.normalize(resolvedPath);
			const normalizedRoot = path.normalize(workspaceRoot);
			return normalizedPath.startsWith(normalizedRoot);
		});

		if (!isWithinWorkspace) {
			throw new Error(
				`Access denied: File is outside workspace boundaries. ` +
				`Path: ${path.basename(filePath)}`
			);
		}
	}

	/**
	 * Fetches server bars with pagination to get full history (up to 5000 bars)
	 * Optimized to avoid excessive array copies during pagination
	 */
	private async fetchServerBarsWithPagination(
		symbol: string,
		timeframe: ServerTimeframe,
		maxBars: number = 5000,
		range?: ChartDateRange,
		token?: vscode.CancellationToken,
		assetClass?: string
	): Promise<ServerBar[]> {
		const client = ServerApiClient.getInstance();
		const batchSize = 500;

		// Crypto endpoint ignores from/to date params -- single fetch only
		if (assetClass?.toLowerCase() === 'crypto') {
			return client.getBars(
				{ symbol, timeframe, limit: Math.min(maxBars, 1000), assetClass },
				token
			);
		}

		const result: ServerBar[] = [];
		const seenTimestamps = new Set<string>(); // Detect duplicates
		let from = range?.start ? Date.parse(range.start) : undefined;
		let to = range?.end ? Date.parse(range.end) : undefined;

		// The server requires an explicit window: a request without from/to returns ZERO
		// bars (verified against the live /v1/bars handler, 2026-06-11) -- it does NOT
		// default to "latest N". Callers that pass no range (e.g. ServerDataCache) would
		// silently get an empty chart, so default to the trailing 5 years here.
		if (from === undefined && to === undefined) {
			to = Date.now();
			from = to - 5 * 365 * 24 * 60 * 60 * 1000;
		}

		// Fetch in batches until we have enough or reach limit
		while (result.length < maxBars) {
			if (token?.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			const bars = await client.getBars({
				symbol,
				timeframe,
				from,
				to,
				limit: batchSize,
				assetClass
			}, token);

			if (bars.length === 0) {
				break;
			}

			// Add bars to result, skipping duplicates
			for (const bar of bars) {
				const timestamp = bar.timestamp;
				if (!seenTimestamps.has(timestamp)) {
					seenTimestamps.add(timestamp);
					result.push(bar);
					if (result.length >= maxBars) {
						break;
					}
				}
			}

			// If we got less than batch size, we've reached the end
			if (bars.length < batchSize) {
				break;
			}

			// Already at max bars
			if (result.length >= maxBars) {
				break;
			}

			// The server returns the MOST RECENT `limit` bars inside the window,
			// sorted ASCENDING (verified against the live /v1/bars handler,
			// 2026-06-11) -- so the oldest bar of the batch is the MINIMUM
			// timestamp, not the last array element. Page backwards from it.
			// (The previous code took bars[length-1] -- the NEWEST bar -- which
			// shrank the window by ~1 bar per request: ~700 sequential HTTP
			// round-trips for a 5y daily history. The chart looked hung.)
			let oldestTime = Number.POSITIVE_INFINITY;
			for (const bar of bars) {
				const t = new Date(bar.timestamp).getTime();
				if (t < oldestTime) {
					oldestTime = t;
				}
			}
			if (!Number.isFinite(oldestTime)) {
				throw new Error(`Unparseable bar timestamps in server response for ${symbol}`);
			}
			to = oldestTime - 1;

			// An exact full batch can land precisely on the window's left edge;
			// the follow-up would then be an inverted (from > to) request.
			// Terminate instead of asking the server for an invalid window.
			if (from !== undefined && to < from) {
				break;
			}
		}

		return result;
	}

	async getOHLCVFromServer(
		symbol: string,
		timeframe: Timeframe,
		range?: ChartDateRange,
		token?: vscode.CancellationToken,
		assetClass?: string
	): Promise<MarketDataResult> {
		const requestId = ++this.requestId;
		if (token?.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		const serverTimeframe = toServerTimeframe(timeframe);

		// DT-3: every call reads through to the transport. No cache, no
		// in-flight dedupe here -- the host's main data module owns both.
		try {
			// Use pagination to fetch up to 5000 bars
			const bars = await this.fetchServerBarsWithPagination(
				symbol,
				serverTimeframe,
				5000,
				range,
				token,
				assetClass
			);

			const data = this.convertServerBars(bars);

			if (!data.length) {
				throw new Error(`No data available for ${symbol} at ${timeframe}`);
			}

			const meta: MarketDataMeta = {
				source: 'server',
				effectiveTimeframe: timeframe,
				symbol
			};

			return { requestId, data, meta };
		} catch (error) {
			if (error instanceof Error && error.message === 'Cancelled') {
				throw error;
			}
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to fetch data from server: ${message}`);
		}
	}

	private convertServerBars(bars: ServerBar[]): OhlcvBar[] {
		return bars.map(bar => ({
			t: this.normalizeTimestamp(bar.timestamp),
			o: bar.open,
			h: bar.high,
			l: bar.low,
			c: bar.close,
			v: bar.volume
		})).sort((a, b) => a.t - b.t);
	}

	/**
	 * Normalizes a timestamp string to UTC milliseconds.
	 * Handles ISO 8601 strings with timezone info, a date-only form (UTC by
	 * the ECMAScript date-only rule), or treats a zone-less date-time as UTC.
	 * Anything else is unparseable and throws, naming the value.
	 */
	private normalizeTimestamp(timestamp: string): number {
		// Check if timestamp has explicit timezone info (Z, z, +HH:MM, -HH:MM)
		const hasTimezone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(timestamp);
		const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(timestamp);

		// With a zone (or date-only, which ECMAScript parses as UTC) parse
		// as-is; a zone-less date-time is treated as UTC by appending 'Z'.
		const parsed = hasTimezone || isDateOnly
			? new Date(timestamp).getTime()
			: new Date(`${timestamp}Z`).getTime();

		if (!Number.isFinite(parsed)) {
			throw new Error(`Unparseable bar timestamp in server response: '${timestamp}'`);
		}

		return parsed;
	}

	inferTimeframe(data: OhlcvBar[]): Timeframe {
		if (data.length < 2) {
			return '1D';
		}

		const sampleSize = Math.min(50, data.length - 1);
		const intervals: number[] = [];
		for (let i = 0; i < sampleSize; i++) {
			intervals.push(data[i + 1].t - data[i].t);
		}
		intervals.sort((a, b) => a - b);
		const median = intervals[Math.floor(intervals.length / 2)];

		const minute = 60 * 1000;
		const hour = 60 * minute;
		const day = 24 * hour;

		if (median < 3 * minute) { return '1m'; }
		if (median < 10 * minute) { return '5m'; }
		if (median < 22 * minute) { return '15m'; }
		if (median < 45 * minute) { return '30m'; }
		if (median < 2.5 * hour) { return '1H'; }
		if (median < 12 * hour) { return '4H'; }
		if (median < 4 * day) { return '1D'; }
		if (median < 15 * day) { return '1W'; }
		return '1M';
	}

	private async loadCsvFile(filePath: string, token?: vscode.CancellationToken): Promise<OhlcvBar[]> {
		return this.withFileRetry(async () => {
			if (token?.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			// DT-3: the file is re-read on every load (no file-bars cache).
			const content = await fs.promises.readFile(filePath, 'utf8');
			return this.parseCsv(content);
		}, filePath, token);
	}

	/**
	 * Retry wrapper for file I/O operations with exponential backoff.
	 * Handles transient errors like EBUSY (file locked), EAGAIN (resource temporarily unavailable).
	 */
	private async withFileRetry<T>(
		operation: () => Promise<T>,
		filePath: string,
		token?: vscode.CancellationToken
	): Promise<T> {
		let lastError: Error | undefined;
		const retryableCodes = new Set(['EBUSY', 'EAGAIN', 'EMFILE', 'ENFILE', 'ETIMEDOUT']);

		for (let attempt = 0; attempt < FILE_READ_MAX_RETRIES; attempt++) {
			// Check cancellation before each attempt
			if (token?.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			try {
				return await operation();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				const code = (error as NodeJS.ErrnoException).code;

				// Don't retry on non-retryable errors
				if (code === 'ENOENT') {
					throw new Error(`File not found: ${filePath}`);
				}
				if (!code || !retryableCodes.has(code)) {
					throw new Error(`Failed to read file: ${lastError.message}`);
				}

				// Wait before retrying with exponential backoff
				if (attempt < FILE_READ_MAX_RETRIES - 1) {
					const delay = FILE_READ_RETRY_DELAY_MS * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw new Error(`Failed to read file after ${FILE_READ_MAX_RETRIES} attempts: ${lastError?.message ?? 'Unknown error'}`);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise(resolve => setTimeout(resolve, ms));
	}

	private async loadParquetFile(_filePath: string, _token?: vscode.CancellationToken): Promise<OhlcvBar[]> {
		throw new Error('Parquet files are not yet supported. Please convert to CSV format.');
	}

	private parseCsv(content: string): OhlcvBar[] {
		const lines = content.split(/\r?\n/).filter(line => line.trim().length > 0);
		if (!lines.length) {
			return [];
		}

		const header = this.splitCsvLine(lines[0]).map(value => value.trim().toLowerCase());
		const timeIndex = this.findIndex(header, ['time', 'timestamp', 'date']);
		const openIndex = this.findIndex(header, ['open', 'o']);
		const highIndex = this.findIndex(header, ['high', 'h']);
		const lowIndex = this.findIndex(header, ['low', 'l']);
		const closeIndex = this.findIndex(header, ['close', 'c']);
		const volumeIndex = this.findIndex(header, ['volume', 'vol', 'v']);

		const barsByTime = new Map<number, OhlcvBar>();

		for (let i = 1; i < lines.length; i++) {
			const raw = lines[i];
			if (!raw) {
				continue;
			}
			const parts = this.splitCsvLine(raw);
			const timeValue = this.parseTime(parts, timeIndex);
			if (timeValue === undefined) {
				continue;
			}
			const open = this.parseNumber(parts, openIndex);
			const high = this.parseNumber(parts, highIndex);
			const low = this.parseNumber(parts, lowIndex);
			const close = this.parseNumber(parts, closeIndex);
			if (!Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
				continue;
			}
			const volume = volumeIndex >= 0 ? this.parseNumber(parts, volumeIndex) : undefined;

			barsByTime.set(timeValue, {
				t: timeValue,
				o: open,
				h: high,
				l: low,
				c: close,
				...(Number.isFinite(volume) && volume !== undefined ? { v: volume } : {})
			});
		}

		return Array.from(barsByTime.values()).sort((a, b) => a.t - b.t);
	}

	private splitCsvLine(line: string): string[] {
		const fields: string[] = [];
		let current = '';
		let inQuotes = false;

		for (let i = 0; i < line.length; i++) {
			const ch = line[i];
			if (inQuotes) {
				if (ch === '"') {
					if (i + 1 < line.length && line[i + 1] === '"') {
						current += '"';
						i++;
					} else {
						inQuotes = false;
					}
				} else {
					current += ch;
				}
			} else {
				if (ch === '"') {
					inQuotes = true;
				} else if (ch === ',') {
					fields.push(current);
					current = '';
				} else {
					current += ch;
				}
			}
		}
		fields.push(current);
		return fields;
	}

	private filterByRange(data: OhlcvBar[], range?: ChartDateRange): OhlcvBar[] {
		if (!range) {
			return data;
		}

		const start = Date.parse(range.start);
		const end = Date.parse(range.end);
		if (!Number.isFinite(start) || !Number.isFinite(end)) {
			return data;
		}

		return data.filter(bar => bar.t >= start && bar.t <= end);
	}

	private findIndex(headers: string[], keys: string[]): number {
		for (const key of keys) {
			const index = headers.indexOf(key);
			if (index >= 0) {
				return index;
			}
		}
		return -1;
	}

	private parseTime(parts: string[], index: number): number | undefined {
		const raw = parts[index >= 0 ? index : 0]?.trim();
		if (!raw) {
			return undefined;
		}
		const numeric = Number(raw);
		if (Number.isFinite(numeric)) {
			return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
		}
		const parsed = Date.parse(raw);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private parseNumber(parts: string[], index: number): number {
		const raw = parts[index >= 0 ? index : 0]?.trim();
		const value = Number(raw);
		return Number.isFinite(value) ? value : NaN;
	}
}
