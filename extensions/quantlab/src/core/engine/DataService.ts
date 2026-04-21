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

const CACHE_LIMIT = 6;
const FILE_CACHE_LIMIT = 6;
const CACHE_TTL_MS = 5 * 60 * 1000;
const SERVER_CACHE_TTL_MS = 60 * 1000; // Shorter cache for server data
const FILE_READ_MAX_RETRIES = 3;
const FILE_READ_RETRY_DELAY_MS = 100;

interface CacheEntry {
	data: OhlcvBar[];
	createdAt: number;
	meta: MarketDataMeta;
}

interface MarketDataMeta {
	source: 'csv' | 'mock' | 'server';
	effectiveTimeframe: Timeframe;
	warning?: string;
	symbol?: string;
}

export interface MarketDataResult {
	requestId: number;
	data: OhlcvBar[];
	meta: MarketDataMeta;
}

interface FileCacheEntry {
	path: string;
	mtimeMs: number;
	sizeBytes: number;
	data: OhlcvBar[];
}

export class DataService {
	private static instance: DataService | undefined;
	private requestId = 0;
	private readonly cache = new Map<string, CacheEntry>();
	private readonly fileCache = new Map<string, FileCacheEntry>();
	private readonly inflight = new Map<string, Promise<MarketDataResult>>();
	private disposed = false;

	static getInstance(): DataService {
		if (!DataService.instance) {
			DataService.instance = new DataService();
		}
		return DataService.instance;
	}

	/**
	 * Disposes all cached data and resources.
	 */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.cache.clear();
		this.fileCache.clear();
		this.inflight.clear();
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

	/**
	 * Clears all cached data without disposing the instance.
	 */
	clearCache(): void {
		this.cache.clear();
		this.fileCache.clear();
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

		// SECURITY: Validate file is within workspace boundaries
		this.validateWorkspacePath(filePath);

		if (!fs.existsSync(filePath)) {
			throw new Error(`File not found: ${filePath}`);
		}

		const ext = path.extname(filePath).toLowerCase();

		// Use null character as delimiter (cannot appear in file paths)
		const key = ['file', filePath, range?.start ?? '', range?.end ?? ''].join('\0');
		const cached = this.getFromCache(key);
		if (cached) {
			return { requestId, data: cached.data, meta: cached.meta };
		}

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
		this.setCache(key, filtered, meta);

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

		// Crypto endpoint ignores from/to date params — single fetch only
		if (assetClass?.toLowerCase() === 'crypto') {
			const bars = await client.getBars(
				{ symbol, timeframe, limit: Math.min(maxBars, 1000), assetClass },
				token
			);
			return bars ?? [];
		}

		const result: ServerBar[] = [];
		const seenTimestamps = new Set<string>(); // Detect duplicates
		let from = range?.start ? Date.parse(range.start) : undefined;
		let to = range?.end ? Date.parse(range.end) : undefined;

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

			if (!bars || bars.length === 0) {
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

			// Update 'to' for next batch (oldest bar's timestamp minus 1ms to avoid overlap)
			const oldestBar = bars[bars.length - 1];
			const oldestTime = new Date(oldestBar.timestamp).getTime();
			to = oldestTime - 1;
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
		// Use null character as delimiter
		const key = ['server', symbol, serverTimeframe, range?.start ?? '', range?.end ?? ''].join('\0');
		const cached = this.getFromCache(key, SERVER_CACHE_TTL_MS);
		if (cached) {
			return { requestId, data: cached.data, meta: cached.meta };
		}

		// Deduplicate concurrent requests for the same key
		const existing = this.inflight.get(key);
		if (existing) {
			const shared = await existing;
			return { ...shared, requestId };
		}

		const fetch = (async () => {
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

				this.setCache(key, data, meta);
				return { requestId, data, meta };
			} catch (error) {
				if (error instanceof Error && error.message === 'Cancelled') {
					throw error;
				}
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`Failed to fetch data from server: ${message}`);
			} finally {
				this.inflight.delete(key);
			}
		})();

		this.inflight.set(key, fetch);
		return fetch;
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
	 * Handles ISO 8601 strings with timezone info, or treats ambiguous times as UTC.
	 */
	private normalizeTimestamp(timestamp: string): number {
		// Check if timestamp has explicit timezone info (Z, z, +HH:MM, -HH:MM)
		const hasTimezone = /[Zz]$|[+-]\d{2}:?\d{2}$/.test(timestamp);

		if (hasTimezone) {
			// Parse as-is (timezone info preserved)
			return new Date(timestamp).getTime();
		}

		// For timestamps without timezone, treat as UTC by appending 'Z'
		const parsed = new Date(`${timestamp}Z`).getTime();

		// Fallback to normal parsing if UTC interpretation fails
		if (!Number.isFinite(parsed)) {
			return new Date(timestamp).getTime();
		}

		return parsed;
	}

	/** @deprecated Use getOHLCVFromFile or getOHLCVFromServer instead */
	async getOHLCV(
		symbol: string,
		timeframe: Timeframe,
		range?: ChartDateRange,
		token?: vscode.CancellationToken
	): Promise<MarketDataResult> {
		const requestId = ++this.requestId;
		if (token?.isCancellationRequested) {
			throw new Error('Cancelled');
		}

		const key = `legacy:${symbol}:${timeframe}:${range?.start ?? ''}:${range?.end ?? ''}`;
		const cached = this.getFromCache(key);
		if (cached) {
			return { requestId, data: cached.data, meta: cached.meta };
		}

		const data = this.generateMockData(symbol, timeframe, range);
		const meta: MarketDataMeta = {
			source: 'mock',
			effectiveTimeframe: timeframe,
			warning: 'No data file selected. Showing simulated data.'
		};

		this.setCache(key, data, meta);
		return { requestId, data, meta };
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

			const stat = await fs.promises.stat(filePath);
			const existing = this.fileCache.get(filePath);
			if (existing && existing.mtimeMs === stat.mtimeMs && existing.sizeBytes === stat.size) {
				// Promote to most-recently-used position
				this.fileCache.delete(filePath);
				this.fileCache.set(filePath, existing);
				return existing.data;
			}

			if (token?.isCancellationRequested) {
				throw new Error('Cancelled');
			}

			const content = await fs.promises.readFile(filePath, 'utf8');
			const data = this.parseCsv(content);
			this.fileCache.set(filePath, { path: filePath, mtimeMs: stat.mtimeMs, sizeBytes: stat.size, data });
			if (this.fileCache.size > FILE_CACHE_LIMIT) {
				const oldest = this.fileCache.keys().next().value as string | undefined;
				if (oldest) {
					this.fileCache.delete(oldest);
				}
			}
			return data;
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

	private getFromCache(key: string, ttl: number = CACHE_TTL_MS): CacheEntry | undefined {
		const entry = this.cache.get(key);
		if (!entry) {
			return undefined;
		}

		if (Date.now() - entry.createdAt > ttl) {
			this.cache.delete(key);
			return undefined;
		}

		return entry;
	}

	private setCache(key: string, data: OhlcvBar[], meta: MarketDataMeta): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		}
		this.cache.set(key, { data, createdAt: Date.now(), meta });
		if (this.cache.size > CACHE_LIMIT) {
			const oldest = this.cache.keys().next().value as string | undefined;
			if (oldest) {
				this.cache.delete(oldest);
			}
		}
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

	private generateMockData(symbol: string, timeframe: Timeframe, range?: ChartDateRange): OhlcvBar[] {
		const step = this.timeframeToMs(timeframe);
		const end = range?.end ? new Date(range.end).getTime() : Date.now();
		const start = range?.start ? new Date(range.start).getTime() : end - step * 200;
		const safeStart = Number.isFinite(start) ? start : end - step * 200;
		const safeEnd = Number.isFinite(end) ? end : Date.now();

		const count = Math.max(30, Math.min(600, Math.floor((safeEnd - safeStart) / step)));
		const seed = this.seedFromString(symbol + timeframe);
		let value = 50 + (seed % 100);

		const bars: OhlcvBar[] = [];
		for (let i = 0; i < count; i++) {
			const t = safeStart + i * step;
			const noise = (this.random(seed + i) - 0.5) * 2;
			const drift = (this.random(seed * 3 + i) - 0.5) * 0.4;
			const delta = (noise + drift) * (value * 0.01);
			const open = value;
			const close = Math.max(1, value + delta);
			const high = Math.max(open, close) + Math.abs(this.random(seed + i * 11)) * value * 0.005;
			const low = Math.min(open, close) - Math.abs(this.random(seed + i * 7)) * value * 0.005;

			bars.push({ t, o: open, h: high, l: low, c: close });
			value = close;
		}

		return bars;
	}

	private timeframeToMs(timeframe: Timeframe): number {
		switch (timeframe) {
			case '1m':
				return 60 * 1000;
			case '5m':
				return 5 * 60 * 1000;
			case '15m':
				return 15 * 60 * 1000;
			case '30m':
				return 30 * 60 * 1000;
			case '1H':
				return 60 * 60 * 1000;
			case '4H':
				return 4 * 60 * 60 * 1000;
			case '1W':
				return 7 * 24 * 60 * 60 * 1000;
			case '1M':
				return 30 * 24 * 60 * 60 * 1000;
			case '1D':
			default:
				return 24 * 60 * 60 * 1000;
		}
	}

	private seedFromString(value: string): number {
		let hash = 0;
		for (let i = 0; i < value.length; i++) {
			hash = (hash << 5) - hash + value.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash);
	}

	private random(seed: number): number {
		const x = Math.sin(seed) * 10000;
		return x - Math.floor(x);
	}
}
