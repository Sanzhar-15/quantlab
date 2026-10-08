/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { promises as fsPromises } from 'fs';
import { randomUUID } from 'crypto';
import { ChartDateRange } from '../../types/chart';
import { ServerDataSource, Timeframe } from '../../types/market';
import { DataService } from './DataService';

/** Run files are named `run-<pid>-<symbol>_<timeframe>_<uuid>.csv`. */
const RUN_FILE_PATTERN = /^run-(\d+)-.+\.csv$/;

const TIMEFRAMES: ReadonlySet<string> = new Set<Timeframe>(['1m', '5m', '15m', '30m', '1H', '4H', '1D', '1W', '1M']);

/**
 * The server source of a run as recorded in its History config (QL-DATA Q-2):
 * History keeps this, never the run-file path, so a rerun re-fetches through
 * writeRunFile instead of reading a file disposed at the first run's end.
 */
export interface RecordedServerSource {
	symbol: string;
	displayName: string;
	assetClass?: string;
	timeframe: Timeframe;
	/** The run's dateStart..dateEnd when both are set; absent = the trailing default window. */
	range?: ChartDateRange;
}

/** Records a first run's server source, timeframe and date range. An unknown timeframe throws. */
export function recordServerSource(source: ServerDataSource, timeframe: unknown, values: Record<string, unknown>): RecordedServerSource {
	if (typeof timeframe !== 'string' || !TIMEFRAMES.has(timeframe)) {
		throw new Error(`Invalid timeframe for the server run: '${String(timeframe)}'`);
	}
	const recorded: RecordedServerSource = { symbol: source.symbol, displayName: source.displayName, timeframe: timeframe as Timeframe };
	if (source.assetClass !== undefined) {
		recorded.assetClass = source.assetClass;
	}
	const { dateStart, dateEnd } = values;
	if (typeof dateStart === 'string' && dateStart && typeof dateEnd === 'string' && dateEnd) {
		if (!Number.isFinite(Date.parse(dateStart)) || !Number.isFinite(Date.parse(dateEnd))) {
			throw new Error(`Invalid run date range: '${dateStart}'..'${dateEnd}'`);
		}
		recorded.range = { start: dateStart, end: dateEnd };
	}
	return recorded;
}

/** Reads a recorded server source back from a History config; anything malformed throws, naming the field. */
export function parseRecordedServerSource(value: unknown): RecordedServerSource {
	const malformed = (field: string): Error => new Error(`The run config's recorded server source is malformed: ${field}`);
	if (typeof value !== 'object' || value === null || Array.isArray(value)) {
		throw malformed('not an object');
	}
	const raw = value as Record<string, unknown>;
	if (typeof raw.symbol !== 'string' || !raw.symbol) {
		throw malformed('symbol');
	}
	if (typeof raw.displayName !== 'string') {
		throw malformed('displayName');
	}
	if (raw.assetClass !== undefined && typeof raw.assetClass !== 'string') {
		throw malformed('assetClass');
	}
	if (typeof raw.timeframe !== 'string' || !TIMEFRAMES.has(raw.timeframe)) {
		throw malformed(`timeframe '${String(raw.timeframe)}'`);
	}
	const recorded: RecordedServerSource = { symbol: raw.symbol, displayName: raw.displayName, timeframe: raw.timeframe as Timeframe };
	if (raw.assetClass !== undefined) {
		recorded.assetClass = raw.assetClass;
	}
	if (raw.range !== undefined) {
		const range = raw.range as Record<string, unknown> | null;
		if (typeof range !== 'object' || range === null || typeof range.start !== 'string' || typeof range.end !== 'string') {
			throw malformed('range');
		}
		recorded.range = { start: range.start, end: range.end };
	}
	return recorded;
}

/** The ServerDataSource a recorded source fetches from. */
export function serverDataSourceOf(recorded: RecordedServerSource): ServerDataSource {
	return { kind: 'server', symbol: recorded.symbol, displayName: recorded.displayName, assetClass: recorded.assetClass };
}

/**
 * A per-run CSV of server bars, written for ONE Python engine run and
 * disposed at that run's end (QL-DATA Q-2 (a)). Never reused across runs.
 */
export interface RunDataFile {
	readonly path: string;
	dispose(): Promise<void>;
}

/**
 * Writes per-run CSV files of server data for Python engine consumption.
 * Server data sources cannot be used directly by Python backtests, so each
 * run gets a fresh CSV that the caller disposes when the run ends.
 *
 * DT-3 (QL-DATA): this is the engine's INPUT, not a cache. There is no reuse
 * window and no retry; the one bars cache lives in the host's main data module.
 */
export class ServerDataCache {
	private static instance: ServerDataCache | undefined;
	private readonly runDir: string;
	/**
	 * Run files written by THIS instance whose deletion has not yet SUCCEEDED. A path leaves this set only when its
	 * unlink succeeded (or the file was already gone, ENOENT): a failed unlink keeps the instance responsible for the
	 * file, so a later explicit dispose or reset tries again.
	 */
	private readonly liveRunFiles = new Set<string>();
	/** Disposals in flight, so two concurrent disposes of one file share ONE unlink attempt. */
	private readonly disposalsInFlight = new Map<string, Promise<void>>();

	private constructor(context: vscode.ExtensionContext) {
		this.runDir = path.join(context.globalStorageUri.fsPath, 'server-data-cache');
		if (!fs.existsSync(this.runDir)) {
			fs.mkdirSync(this.runDir, { recursive: true });
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

	/**
	 * Deletes every run file this instance wrote and has not disposed (a run
	 * still in flight at deactivation). Each failure is logged, then all are
	 * thrown together. A file whose unlink failed stays owned by the retired
	 * instance, so its RunDataFile.dispose() can still delete it.
	 */
	static resetInstance(): void {
		if (ServerDataCache.instance) {
			const instance = ServerDataCache.instance;
			ServerDataCache.instance = undefined;
			const failures: string[] = [];
			for (const runPath of Array.from(instance.liveRunFiles)) {
				try {
					fs.unlinkSync(runPath);
					instance.liveRunFiles.delete(runPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
						// Already gone: nothing is left to own (the failure is still reported below).
						instance.liveRunFiles.delete(runPath);
					}
					const message = `${runPath}: ${error instanceof Error ? error.message : String(error)}`;
					console.error(`ServerDataCache: failed to delete run data file ${message}`);
					failures.push(message);
				}
			}
			if (failures.length) {
				throw new Error(`ServerDataCache: ${failures.length} run data file(s) could not be deleted: ${failures.join('; ')}`);
			}
		}
	}

	/**
	 * Fetch server data and write it to a fresh per-run CSV for ONE Python
	 * engine run. The caller disposes the returned file when the run ends.
	 *
	 * @param source Server data source descriptor
	 * @param timeframe Timeframe to fetch (e.g., '1D', '1H')
	 * @param range The run's date range; absent = DataService's trailing default window
	 * @returns The run file: its path and its dispose
	 */
	async writeRunFile(
		source: ServerDataSource,
		timeframe: Timeframe,
		range?: ChartDateRange
	): Promise<RunDataFile> {
		// Validate symbol to prevent header injection attacks
		this.validateSymbol(source.symbol);

		const result = await DataService.getInstance().getOHLCVFromServer(
			source.symbol, timeframe, range, undefined, source.assetClass
		);

		if (result.data.length === 0) {
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

		// A unique name per run: two runs never share (or reuse) a file.
		// 'wx' refuses to overwrite anything already at that path.
		const sanitized = source.symbol.replace(/[^a-zA-Z0-9]/g, '_');
		const runPath = path.join(this.runDir, `run-${process.pid}-${sanitized}_${timeframe}_${randomUUID()}.csv`);
		this.liveRunFiles.add(runPath);
		try {
			await fsPromises.writeFile(runPath, header + rows, { encoding: 'utf8', flag: 'wx' });
		} catch (error) {
			const writeMessage = error instanceof Error ? error.message : String(error);
			if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
				// 'wx' refused: the file at this path is not ours, so it is never unlinked and never owned.
				this.liveRunFiles.delete(runPath);
			} else {
				// A partial file may exist; remove it. ENOENT = the write never created it. A failed unlink keeps the
				// path owned (the next resetInstance tries again); it is not forgotten here.
				try {
					await this.unlinkOwned(runPath);
				} catch (cleanupError) {
					if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
						const cleanupMessage = cleanupError instanceof Error ? cleanupError.message : String(cleanupError);
						throw new Error(`Failed to write run data file ${runPath}: ${writeMessage}; removing the partial file also failed: ${cleanupMessage}`);
					}
				}
			}
			throw new Error(`Failed to write run data file ${runPath}: ${writeMessage}`);
		}

		return {
			path: runPath,
			dispose: () => this.disposeRunFile(runPath)
		};
	}

	/**
	 * Deletes one run file. Idempotent once the deletion has succeeded: a second dispose (or one after
	 * resetInstance already deleted it) does nothing. Any unlink failure throws and leaves the file owned, so the
	 * next explicit dispose or reset tries again; nothing is retried automatically.
	 */
	private disposeRunFile(runPath: string): Promise<void> {
		if (!this.liveRunFiles.has(runPath)) {
			return Promise.resolve();
		}
		const inFlight = this.disposalsInFlight.get(runPath);
		if (inFlight) {
			return inFlight;
		}
		const disposal = this.unlinkOwned(runPath).finally(() => this.disposalsInFlight.delete(runPath));
		this.disposalsInFlight.set(runPath, disposal);
		return disposal;
	}

	/**
	 * One unlink attempt of an owned run file. Ownership ends when the unlink succeeded, or failed with ENOENT (the
	 * file is already gone, so nothing is left to clean up; the error still throws). Any other failure throws and
	 * keeps the path owned.
	 */
	private async unlinkOwned(runPath: string): Promise<void> {
		try {
			await fsPromises.unlink(runPath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				this.liveRunFiles.delete(runPath);
			}
			throw error;
		}
		this.liveRunFiles.delete(runPath);
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
	 * Volume must be present, finite and non-negative: a missing volume is a
	 * malformed bar, never written as 0.
	 */
	private sanitizeVolume(value: number | undefined): number {
		if (value === undefined) {
			throw new Error('Invalid volume: missing (a server bar without volume)');
		}
		if (!Number.isFinite(value)) {
			throw new Error(`Invalid volume: ${value} (must be finite number)`);
		}
		if (value < 0) {
			throw new Error(`Invalid volume: ${value} (must be non-negative)`);
		}
		return value;
	}

	/**
	 * Startup sweep (called once at activation). The old age-based reuse
	 * cleanup is gone with the reuse window; this removes the residue a
	 * crashed session left behind: legacy reuse files (`<symbol>_<tf>.csv`,
	 * `.tmp`) and run files whose owning process is no longer alive. A run
	 * file of a live process (another window, or this one) is never touched.
	 * Failures are logged and shown, never dropped.
	 */
	clearOldCache(): void {
		this.sweepResidue().catch(error => {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`ServerDataCache: residue sweep failed: ${message}`);
			void vscode.window.showWarningMessage(`Quantlab could not clean up old server-data run files: ${message}`);
		});
	}

	async sweepResidue(): Promise<void> {
		const files = await fsPromises.readdir(this.runDir);
		const failures: string[] = [];
		for (const file of files) {
			const match = RUN_FILE_PATTERN.exec(file);
			if (match && ServerDataCache.isProcessAlive(Number(match[1]))) {
				continue;
			}
			const filePath = path.join(this.runDir, file);
			try {
				await fsPromises.unlink(filePath);
			} catch (error) {
				failures.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
		if (failures.length) {
			throw new Error(`${failures.length} file(s) could not be deleted: ${failures.join('; ')}`);
		}
	}

	/** Signal 0 probes a pid: ESRCH = no such process; EPERM = alive, not ours. */
	private static isProcessAlive(pid: number): boolean {
		if (pid === process.pid) {
			return true;
		}
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === 'ESRCH') {
				return false;
			}
			if (code === 'EPERM') {
				return true;
			}
			throw error;
		}
	}
}
