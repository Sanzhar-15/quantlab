/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { ServerDataSource, Timeframe } from '../../types/market';
import { DataService } from './DataService';

/**
 * Manages temporary CSV caching of server data for Python engine consumption.
 * Server data sources cannot be used directly by Python backtests, so we fetch
 * and cache them as CSV files.
 */
export class ServerDataCache {
	private static instance: ServerDataCache | undefined;
	private cacheDir: string;

	private constructor(context: vscode.ExtensionContext) {
		this.cacheDir = path.join(context.globalStorageUri.fsPath, 'server-data-cache');
		if (!fs.existsSync(this.cacheDir)) {
			fs.mkdirSync(this.cacheDir, { recursive: true });
		}
	}

	static initialize(context: vscode.ExtensionContext): void {
		ServerDataCache.instance = new ServerDataCache(context);
	}

	static getInstance(): ServerDataCache {
		if (!ServerDataCache.instance) {
			throw new Error('ServerDataCache not initialized');
		}
		return ServerDataCache.instance;
	}

	static resetInstance(): void {
		if (ServerDataCache.instance) {
			ServerDataCache.instance.clearOldCache();
			ServerDataCache.instance = undefined;
		}
	}

	/**
	 * Fetch server data and save to temp CSV for Python engine consumption.
	 * Returns the path to the cached CSV file.
	 *
	 * @param source Server data source descriptor
	 * @param timeframe Timeframe to fetch (e.g., '1D', '1H')
	 * @returns Path to cached CSV file
	 */
	async fetchAndCacheToCSV(
		source: ServerDataSource,
		timeframe: Timeframe
	): Promise<string> {
		// Validate symbol to prevent header injection attacks
		this.validateSymbol(source.symbol);

		const sanitized = source.symbol.replace(/[^a-zA-Z0-9]/g, '_');
		const cachePath = path.join(this.cacheDir, `${sanitized}_${timeframe}.csv`);

		// Check if cache exists and is recent (< 5 minutes old)
		try {
			const stats = await fsPromises.stat(cachePath);
			const ageMs = Date.now() - stats.mtimeMs;
			if (ageMs < 5 * 60 * 1000) {
				return cachePath; // Use cached file
			}
		} catch (error) {
			// File doesn't exist, continue to fetch fresh data
		}

		// Fetch fresh data with timeout and retry
		const dataService = DataService.getInstance();
		const result = await this.fetchWithRetry(() =>
			dataService.getOHLCVFromServer(source.symbol, timeframe, undefined, undefined, source.assetClass)
		, 2, 30000);

		if (!result || !result.data || result.data.length === 0) {
			throw new Error(`No data available for ${source.symbol}`);
		}

		// Write CSV with proper format and validation
		const header = 'timestamp,open,high,low,close,volume\n';
		const rows = result.data.map(bar => {
			// Convert milliseconds timestamp to ISO date string
			const date = new Date(bar.t).toISOString();

			// Sanitize numeric values (check for NaN/Infinity)
			const open = this.sanitizeNumeric(bar.o, 'open');
			const high = this.sanitizeNumeric(bar.h, 'high');
			const low = this.sanitizeNumeric(bar.l, 'low');
			const close = this.sanitizeNumeric(bar.c, 'close');
			const volume = this.sanitizeVolume(bar.v);

			return `${date},${open},${high},${low},${close},${volume}`;
		}).join('\n');

		// Atomic write: write to temp file, then rename
		const tempPath = `${cachePath}.tmp`;
		await fsPromises.writeFile(tempPath, header + rows, 'utf8');
		await fsPromises.rename(tempPath, cachePath);

		return cachePath;
	}

	/**
	 * Fetch with timeout and retry logic for transient failures
	 */
	private async fetchWithRetry<T>(
		fetchFn: () => Promise<T>,
		maxRetries: number,
		timeoutMs: number
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				// Wrap in timeout promise — store handle to clear it on success
				let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
				const result = await Promise.race([
					fetchFn(),
					new Promise<never>((_, reject) => {
						timeoutHandle = setTimeout(() => reject(new Error('Request timeout')), timeoutMs);
					})
				]);
				clearTimeout(timeoutHandle);
				return result;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on last attempt
				if (attempt < maxRetries) {
					// Wait before retry (exponential backoff: 1s, 2s)
					await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, attempt)));
				}
			}
		}

		throw lastError ?? new Error('Fetch failed with unknown error');
	}

	/**
	 * Validate symbol to prevent CSV header injection
	 */
	private validateSymbol(symbol: string): void {
		// Check for dangerous characters that could inject CSV headers
		const dangerousChars = /[\n\r,;"']/;
		if (dangerousChars.test(symbol)) {
			throw new Error(`Invalid symbol: contains dangerous characters`);
		}

		// Validate symbol format (alphanumeric with optional ., -, _, /)
		const validSymbol = /^[a-zA-Z0-9._\-/]+$/;
		if (!validSymbol.test(symbol)) {
			throw new Error(`Invalid symbol format: ${symbol}`);
		}

		// Length check
		if (symbol.length === 0 || symbol.length > 50) {
			throw new Error(`Invalid symbol length: must be 1-50 characters`);
		}
	}

	/**
	 * Sanitize numeric value to prevent NaN/Infinity in CSV
	 */
	private sanitizeNumeric(value: number, fieldName: string): number {
		if (!Number.isFinite(value)) {
			throw new Error(`Invalid ${fieldName}: ${value} (must be finite number)`);
		}
		return value;
	}

	/**
	 * Sanitize volume to ensure non-negative
	 */
	private sanitizeVolume(value: number | undefined): number {
		const vol = value ?? 0;
		if (!Number.isFinite(vol)) {
			throw new Error(`Invalid volume: ${vol} (must be finite number)`);
		}
		if (vol < 0) {
			throw new Error(`Invalid volume: ${vol} (must be non-negative)`);
		}
		return vol;
	}

	/**
	 * Clear cache files older than 1 day (async to avoid blocking event loop)
	 */
	clearOldCache(): void {
		void this._clearOldCacheAsync();
	}

	private async _clearOldCacheAsync(): Promise<void> {
		try {
			await fsPromises.access(this.cacheDir);
		} catch {
			return; // Cache dir doesn't exist
		}

		const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
		let files: string[];
		try {
			files = await fsPromises.readdir(this.cacheDir);
		} catch {
			return;
		}

		await Promise.allSettled(files.map(async (file) => {
			const filePath = path.join(this.cacheDir, file);
			try {
				const stats = await fsPromises.stat(filePath);
				if (stats.mtimeMs < oneDayAgo) {
					await fsPromises.unlink(filePath);
				}
			} catch {
				// File may have been deleted concurrently — ignore
			}
		}));
	}

	/**
	 * Clear all cache files
	 */
	clearAllCache(): void {
		if (!fs.existsSync(this.cacheDir)) {
			return;
		}

		const files = fs.readdirSync(this.cacheDir);
		for (const file of files) {
			const filePath = path.join(this.cacheDir, file);
			try {
				fs.unlinkSync(filePath);
			} catch (error) {
				// Ignore errors
			}
		}
	}
}
