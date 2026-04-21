/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ToolResultPayload } from '../canonical/types.js';
import type { OptimizedSecretScanner } from '../security/secretScanner.js';
import { QicError } from '../canonical/types.js';

// XI-SV7: Files blocked entirely from read access
const BLOCKED_READ_PATTERNS = [
	'.env',
	'.env.local',
	'.env.production',
	'.env.development',
	'.env.staging',
	'.env.test',
	'.env.ci',
	'.env.docker',
	'.env.backup',
	'.env.bak',
	'.vscode/settings.json',
	'.npmrc',
	'.yarnrc',
	'credentials.json',
	'service-account.json',
	'id_rsa',
	'id_ed25519',
	'id_ecdsa',
	'id_dsa',
	'.ssh/config',
	'.ssh/known_hosts',
	'.ssh/authorized_keys',
	'.git/config',
	'.docker/config.json',
	'.netrc',
	'.htpasswd',
	'kubeconfig',
];

// Data file extensions that get smart formatting
// Note: .parquet excluded as it's binary (requires special handling)
const DATA_FILE_EXTENSIONS = ['.csv', '.tsv', '.json', '.jsonl'];

// Threshold for smart summarization (lines)
const SMART_SUMMARY_THRESHOLD = 100;

// Source file truncation threshold (lines)
const SOURCE_TRUNCATION_THRESHOLD = 500;
const SOURCE_HEAD_LINES = 100;
const SOURCE_TAIL_LINES = 50;

// Directories to skip in list_directory
const IGNORED_DIRS = new Set([
	'node_modules', '.git', '__pycache__', '.next', 'dist', 'build',
	'.venv', 'venv', 'coverage', '.cache', '.tox', '.mypy_cache', '.pytest_cache',
]);

// Maximum depth for recursive directory listing
const MAX_LIST_DEPTH = 4;

// File cache settings
const MAX_CACHE_ENTRIES = 100;

/**
 * mtime-based file content cache. Per-conversation, FIFO eviction.
 */
class FileCache {
	private readonly entries = new Map<string, { content: string; mtime: number }>();
	private readonly order: string[] = [];

	get(key: string): { content: string; mtime: number } | undefined {
		return this.entries.get(key);
	}

	set(key: string, content: string, mtime: number): void {
		if (!this.entries.has(key)) {
			this.order.push(key);
		}
		this.entries.set(key, { content, mtime });
		// FIFO eviction
		while (this.order.length > MAX_CACHE_ENTRIES) {
			const evicted = this.order.shift()!;
			this.entries.delete(evicted);
		}
	}

	invalidate(key: string): void {
		this.entries.delete(key);
		const idx = this.order.indexOf(key);
		if (idx >= 0) { this.order.splice(idx, 1); }
	}
}

/**
 * Format a file size as human-readable string.
 */
function formatFileSize(bytes: number): string {
	if (bytes > 1024 * 1024) {
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
	if (bytes > 1024) {
		return `${(bytes / 1024).toFixed(1)} KB`;
	}
	return `${bytes} bytes`;
}

/**
 * Add line numbers to content lines.
 * Format: "  NNN | content" with padding to align pipes.
 */
function addLineNumbers(lines: string[], startLine: number): string {
	const maxNum = startLine + lines.length - 1;
	const padWidth = String(maxNum).length;
	return lines.map((line, i) => {
		const num = String(startLine + i).padStart(padWidth);
		return `${num} | ${line}`;
	}).join('\n');
}

/**
 * File operation tools (7 tools).
 *
 * Uses VS Code's IFileService for file system access, which works in
 * sandboxed renderer environments where Node.js fs is not available.
 *
 * Audit XI-SV2: All operations validate paths within workspace.
 * Audit XI-SV7: read_file blocks sensitive files.
 *
 * BYOK Optimization: Large data files get smart summaries instead of
 * raw content dumps to help models respond more concisely.
 * Source files >500 lines get head/tail truncation with line numbers.
 * File content cache eliminates redundant disk I/O.
 */
export class FileOperationTools {

	private readonly cache = new FileCache();

	constructor(
		private readonly workspaceRoot: string,
		private readonly secretScanner: OptimizedSecretScanner,
		private readonly fileService: IFileService,
	) {}

	/**
	 * Read file content with caching. Returns content and mtime.
	 */
	private async readFileContent(fileUri: URI, resolvedPath: string): Promise<{ content: string; mtime: number }> {
		const cached = this.cache.get(resolvedPath);
		if (cached) {
			// Validate via stat (cheap metadata call)
			try {
				const stat = await this.fileService.stat(fileUri);
				if (stat.mtime === cached.mtime) {
					return cached;
				}
			} catch {
				// stat failed — fall through to full read
			}
		}
		const contentBuffer = await this.fileService.readFile(fileUri);
		const content = contentBuffer.value.toString();
		const mtime = contentBuffer.mtime;
		this.cache.set(resolvedPath, content, mtime);
		return { content, mtime };
	}

	// 1. read_file
	async readFile(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const resolvedPath = this.validatePath(filePath);
			const fileUri = URI.file(resolvedPath);

			// XI-SV7: Block sensitive files
			const relative = path.relative(this.workspaceRoot, resolvedPath);
			for (const blocked of BLOCKED_READ_PATTERNS) {
				if (relative === blocked || relative.endsWith(`/${blocked}`)) {
					throw new QicError('QIC-P003', `File blocked for security: ${blocked}`);
				}
			}

			// Block key/certificate files by extension
			const ext = path.extname(relative).toLowerCase();
			if (['.pem', '.key', '.p12', '.pfx', '.jks'].includes(ext)) {
				throw new QicError('QIC-P003', `File blocked for security: ${ext} files`);
			}

			const { content } = await this.readFileContent(fileUri, resolvedPath);

			// Check if user requested specific line range
			const hasLineRange = args.startLine !== undefined || args.endLine !== undefined;

			// Apply line range if specified
			if (hasLineRange) {
				const lines = content.split('\n');
				const start = Math.max(0, (Number(args.startLine) || 1) - 1);
				const end = args.endLine ? Number(args.endLine) : lines.length;
				const sliced = lines.slice(start, end);

				// Add line numbers and metadata header
				const fileSize = new TextEncoder().encode(content).length;
				const header = `# ${filePath} — ${lines.length} lines, ${formatFileSize(fileSize)} (showing lines ${start + 1}–${Math.min(end, lines.length)})`;
				const numbered = addLineNumbers(sliced, start + 1);

				const redacted = this.secretScanner.redact(`${header}\n${numbered}`);
				return { content: redacted, isError: false };
			}

			// Check if this is a data file that should get smart formatting
			const isDataFile = DATA_FILE_EXTENSIONS.includes(ext);
			const lines = content.split('\n');
			// Only summarize if we have enough lines and the file isn't empty
			const shouldSummarize = isDataFile && lines.length > SMART_SUMMARY_THRESHOLD && content.trim().length > 0;

			if (shouldSummarize) {
				const summary = this.createDataFileSummary(content, lines, ext, filePath);
				return { content: summary, isError: false };
			}

			// Source file truncation for large non-data files
			if (!isDataFile && lines.length > SOURCE_TRUNCATION_THRESHOLD) {
				const summary = this.createSourceFileSummary(content, lines, filePath);
				const redacted = this.secretScanner.redact(summary);
				return { content: redacted, isError: false };
			}

			// Normal file: add line numbers and metadata header
			const fileSize = new TextEncoder().encode(content).length;
			const header = `# ${filePath} — ${lines.length} lines, ${formatFileSize(fileSize)}`;
			const numbered = addLineNumbers(lines, 1);

			const redacted = this.secretScanner.redact(`${header}\n${numbered}`);
			return { content: redacted, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	/**
	 * Create a smart truncation for large source files (>500 lines).
	 * Shows first 100 lines (imports/headers) + last 50 lines (exports/main)
	 * with line numbers and an omission marker.
	 */
	private createSourceFileSummary(content: string, lines: string[], filePath: string): string {
		const totalLines = lines.length;
		const fileSize = new TextEncoder().encode(content).length;

		const headLines = lines.slice(0, SOURCE_HEAD_LINES);
		const tailLines = lines.slice(-SOURCE_TAIL_LINES);
		const omittedStart = SOURCE_HEAD_LINES + 1;
		const omittedEnd = totalLines - SOURCE_TAIL_LINES;
		const omittedCount = omittedEnd - omittedStart + 1;

		const parts: string[] = [];
		parts.push(`# ${filePath} — ${totalLines} lines, ${formatFileSize(fileSize)}`);
		parts.push(addLineNumbers(headLines, 1));
		parts.push(`[... lines ${omittedStart}–${omittedEnd} omitted (${omittedCount} lines) — use startLine/endLine to read specific sections ...]`);
		parts.push(addLineNumbers(tailLines, totalLines - SOURCE_TAIL_LINES + 1));

		return parts.join('\n');
	}

	/**
	 * Create a smart summary for large data files.
	 * Provides metadata, sample rows, and detected patterns to help the model
	 * answer questions without processing the entire file.
	 */
	private createDataFileSummary(content: string, lines: string[], ext: string, filePath: string): string {
		const totalLines = lines.length;
		// Use TextEncoder for byte length (works in sandboxed renderer, unlike Buffer)
		const fileSize = new TextEncoder().encode(content).length;

		const parts: string[] = [];

		// Header
		parts.push(`## File Summary: ${path.basename(filePath)}`);
		parts.push(`- **Format**: ${ext.slice(1).toUpperCase()}`);
		parts.push(`- **Size**: ${formatFileSize(fileSize)}`);
		parts.push(`- **Lines**: ${totalLines.toLocaleString()}`);

		if (ext === '.csv' || ext === '.tsv') {
			const delimiter = ext === '.tsv' ? '\t' : ',';
			const csvSummary = this.summarizeCsv(lines, delimiter);
			parts.push(`- **Columns**: ${csvSummary.columns.length} (${csvSummary.columns.join(', ')})`);

			// Detect timestamp columns and date range
			if (csvSummary.dateRange) {
				parts.push(`- **Date Range**: ${csvSummary.dateRange.start} to ${csvSummary.dateRange.end}`);
				if (csvSummary.dateRange.isFuture) {
					parts.push(`- **Note**: Dates are in the future — this appears to be synthetic/test data`);
				}
			}

			parts.push('');
			parts.push('### First 5 rows:');
			parts.push('```');
			parts.push(csvSummary.firstRows.join('\n'));
			parts.push('```');

			parts.push('');
			parts.push('### Last 5 rows:');
			parts.push('```');
			parts.push(csvSummary.lastRows.join('\n'));
			parts.push('```');

		} else if (ext === '.json') {
			const jsonSummary = this.summarizeJson(content);
			if (jsonSummary) {
				parts.push(`- **Structure**: ${jsonSummary.structure}`);
				if (jsonSummary.arrayLength) {
					parts.push(`- **Array Length**: ${jsonSummary.arrayLength.toLocaleString()} items`);
				}
				if (jsonSummary.keys) {
					parts.push(`- **Keys**: ${jsonSummary.keys.join(', ')}`);
				}

				parts.push('');
				parts.push('### Sample:');
				parts.push('```json');
				parts.push(jsonSummary.sample);
				parts.push('```');
			}
		} else if (ext === '.jsonl') {
			parts.push('');
			parts.push('### First 5 lines:');
			parts.push('```json');
			parts.push(lines.slice(0, 5).join('\n'));
			parts.push('```');

			parts.push('');
			parts.push('### Last 5 lines:');
			parts.push('```json');
			parts.push(lines.slice(-5).join('\n'));
			parts.push('```');
		}

		parts.push('');
		parts.push('---');
		parts.push('*Use `startLine` and `endLine` parameters to read specific sections.*');

		return parts.join('\n');
	}

	/**
	 * Summarize a CSV file, detecting columns and potential timestamp fields.
	 */
	private summarizeCsv(lines: string[], delimiter: string): {
		columns: string[];
		firstRows: string[];
		lastRows: string[];
		dateRange?: { start: string; end: string; isFuture: boolean };
	} {
		const header = lines[0] || '';
		const columns = header.split(delimiter).map(c => c.trim().replace(/^["']|["']$/g, ''));

		// Get first and last rows (including header for context)
		const firstRows = lines.slice(0, 6); // Header + 5 data rows
		const lastRows = lines.slice(-5);

		// Try to detect date range from timestamp-like columns
		let dateRange: { start: string; end: string; isFuture: boolean } | undefined;

		// Comprehensive timestamp column detection
		const timestampColIndex = columns.findIndex(c => {
			const normalized = c.toLowerCase().replace(/[_\-\s]/g, '');
			return /^(timestamp|time|date|datetime|created|updated|createdat|updatedat|ts|dt|tradetime|orderdate|tradedate|epoch)$/.test(normalized);
		});

		if (timestampColIndex >= 0 && lines.length > 1) {
			try {
				const firstDataRow = lines[1]?.split(delimiter);
				const lastDataRow = lines[lines.length - 1]?.split(delimiter);

				if (firstDataRow && lastDataRow) {
					const firstValue = firstDataRow[timestampColIndex]?.trim().replace(/^["']|["']$/g, '');
					const lastValue = lastDataRow[timestampColIndex]?.trim().replace(/^["']|["']$/g, '');

					const firstDate = this.parseTimestamp(firstValue);
					const lastDate = this.parseTimestamp(lastValue);

					if (firstDate && lastDate) {
						const now = new Date();
						dateRange = {
							start: firstDate.toISOString().split('T')[0],
							end: lastDate.toISOString().split('T')[0],
							isFuture: firstDate > now || lastDate > now,
						};
					}
				}
			} catch {
				// Ignore parsing errors
			}
		}

		return { columns, firstRows, lastRows, dateRange };
	}

	/**
	 * Parse a timestamp value (Unix epoch or ISO string).
	 */
	private parseTimestamp(value: string): Date | null {
		if (!value) return null;

		// Try Unix timestamp (seconds or milliseconds)
		const num = Number(value);
		if (!isNaN(num) && num > 0) {
			// 10 digits = seconds, 13 digits = milliseconds
			const ms = num > 1e12 ? num : num * 1000;
			const date = new Date(ms);
			if (!isNaN(date.getTime())) return date;
		}

		// Try ISO string
		const isoDate = new Date(value);
		if (!isNaN(isoDate.getTime())) return isoDate;

		return null;
	}

	/**
	 * Summarize a JSON file.
	 */
	private summarizeJson(content: string): {
		structure: string;
		arrayLength?: number;
		keys?: string[];
		sample: string;
	} | null {
		try {
			const parsed = JSON.parse(content);

			if (Array.isArray(parsed)) {
				const sample = parsed.slice(0, 3);
				const keys = parsed[0] && typeof parsed[0] === 'object'
					? Object.keys(parsed[0])
					: undefined;

				return {
					structure: 'Array of ' + (typeof parsed[0] === 'object' ? 'objects' : typeof parsed[0]),
					arrayLength: parsed.length,
					keys,
					sample: JSON.stringify(sample, null, 2),
				};
			} else if (typeof parsed === 'object' && parsed !== null) {
				const keys = Object.keys(parsed);
				// Create a truncated sample
				const sampleObj: Record<string, unknown> = {};
				for (const key of keys.slice(0, 10)) {
					const value = parsed[key];
					if (Array.isArray(value)) {
						sampleObj[key] = `[Array of ${value.length} items]`;
					} else if (typeof value === 'object' && value !== null) {
						sampleObj[key] = '{...}';
					} else {
						sampleObj[key] = value;
					}
				}
				if (keys.length > 10) {
					sampleObj['...'] = `(${keys.length - 10} more keys)`;
				}

				return {
					structure: 'Object',
					keys: keys.slice(0, 20),
					sample: JSON.stringify(sampleObj, null, 2),
				};
			}

			return null;
		} catch {
			return null;
		}
	}

	// 2. write_file
	async writeFile(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const content = String(args.content ?? '');
			const resolvedPath = this.validatePath(filePath);
			const fileUri = URI.file(resolvedPath);

			// Create parent directories if needed
			const parentUri = URI.file(path.dirname(resolvedPath));
			try {
				await this.fileService.createFolder(parentUri);
			} catch {
				// Parent may already exist
			}

			await this.fileService.writeFile(fileUri, VSBuffer.fromString(content));
			// Invalidate cache on write
			this.cache.invalidate(resolvedPath);

			const bytes = VSBuffer.fromString(content).byteLength;
			return { content: `Written ${bytes} bytes to ${filePath}`, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 3. edit_file — search/replace with fuzzy fallback
	async editFile(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const oldString = String(args.old_string ?? '');
			const newString = String(args.new_string ?? '');
			const resolvedPath = this.validatePath(filePath);
			const fileUri = URI.file(resolvedPath);

			// XI-SV7: Block sensitive files
			const relative = path.relative(this.workspaceRoot, resolvedPath);
			for (const blocked of BLOCKED_READ_PATTERNS) {
				if (relative === blocked || relative.endsWith(`/${blocked}`)) {
					throw new QicError('QIC-P003', `File blocked for security: ${blocked}`);
				}
			}

			// Guard: empty old_string
			if (!oldString) {
				return {
					content: 'old_string cannot be empty. To create a new file, use write_file.',
					isError: true,
				};
			}

			// Read file content (from cache if mtime matches)
			const { content } = await this.readFileContent(fileUri, resolvedPath);

			// Guard: binary file
			if (content.includes('\0')) {
				return { content: 'Cannot edit binary files.', isError: true };
			}

			// Literal match
			const matchIndex = content.indexOf(oldString);

			let finalContent: string;
			let matchStart: number;
			let replacedLineCount: number;
			let newLineCount: number;

			if (matchIndex >= 0) {
				// Ambiguity check: ensure only one match
				const secondMatch = content.indexOf(oldString, matchIndex + 1);
				if (secondMatch >= 0) {
					return {
						content: `old_string matches multiple locations (at least 2). Add more surrounding context to make it unique.`,
						isError: true,
					};
				}

				finalContent = content.slice(0, matchIndex) + newString + content.slice(matchIndex + oldString.length);
				matchStart = matchIndex;
				replacedLineCount = oldString.split('\n').length;
				newLineCount = newString.split('\n').length;
			} else {
				// Fuzzy fallback: slide window of old_string line count across file
				const oldLines = oldString.split('\n').map(l => l.trim());
				const contentLines = content.split('\n');
				const windowSize = oldLines.length;

				if (windowSize > contentLines.length) {
					return {
						content: `old_string not found in ${filePath}. Ensure text matches exactly (including whitespace and indentation).`,
						isError: true,
					};
				}

				const fuzzyMatches: { index: number; similarity: number }[] = [];

				for (let i = 0; i <= contentLines.length - windowSize; i++) {
					const windowLines = contentLines.slice(i, i + windowSize).map(l => l.trim());
					let matching = 0;
					for (let j = 0; j < windowSize; j++) {
						if (windowLines[j] === oldLines[j]) {
							matching++;
						}
					}
					const similarity = matching / windowSize;
					if (similarity > 0.85) {
						fuzzyMatches.push({ index: i, similarity });
					}
				}

				if (fuzzyMatches.length === 0) {
					return {
						content: `old_string not found in ${filePath}. Ensure text matches exactly (including whitespace and indentation).`,
						isError: true,
					};
				}

				if (fuzzyMatches.length > 1) {
					return {
						content: `old_string matches multiple locations via fuzzy match (${fuzzyMatches.length} matches). Add more surrounding context to make it unique.`,
						isError: true,
					};
				}

				// Single fuzzy match — apply replacement
				const fuzzyStart = fuzzyMatches[0].index;
				const before = contentLines.slice(0, fuzzyStart);
				const after = contentLines.slice(fuzzyStart + windowSize);
				const newLines = newString.split('\n');
				finalContent = [...before, ...newLines, ...after].join('\n');

				// Calculate matchStart byte offset for context echo
				matchStart = before.join('\n').length + (before.length > 0 ? 1 : 0);
				replacedLineCount = windowSize;
				newLineCount = newLines.length;
			}

			// Write the edited content
			await this.fileService.writeFile(fileUri, VSBuffer.fromString(finalContent));
			this.cache.invalidate(resolvedPath);

			// Build context echo — 3 lines before/after edit with line numbers
			const finalLines = finalContent.split('\n');
			// Find the line number where the edit starts
			const editStartLine = content.slice(0, matchStart).split('\n').length;
			const contextBefore = 3;
			const contextAfter = 3;

			const echoStart = Math.max(0, editStartLine - 1 - contextBefore);
			const echoEnd = Math.min(finalLines.length, editStartLine - 1 + newLineCount + contextAfter);
			const echoLines = finalLines.slice(echoStart, echoEnd);

			const padWidth = String(echoEnd).length;
			const echoFormatted = echoLines.map((line, i) => {
				const lineNum = echoStart + i + 1;
				const num = String(lineNum).padStart(padWidth);
				const isEdited = lineNum >= editStartLine && lineNum < editStartLine + newLineCount;
				const prefix = isEdited ? '>' : ' ';
				return `${prefix} ${num} | ${line}`;
			}).join('\n');

			const header = `Edited ${filePath} (replaced ${replacedLineCount} line${replacedLineCount !== 1 ? 's' : ''} with ${newLineCount} line${newLineCount !== 1 ? 's' : ''})`;

			return {
				content: `${header}\n\n${echoFormatted}`,
				isError: false,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 4. delete_file
	async deleteFile(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const resolvedPath = this.validatePath(filePath);
			const fileUri = URI.file(resolvedPath);

			await this.fileService.del(fileUri);
			this.cache.invalidate(resolvedPath);
			return { content: `Deleted ${filePath}`, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 5. move_file
	async moveFile(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const source = String(args.source ?? '');
			const destination = String(args.destination ?? '');
			const resolvedSource = this.validatePath(source);
			const resolvedDest = this.validatePath(destination);
			const sourceUri = URI.file(resolvedSource);
			const destUri = URI.file(resolvedDest);

			// Create parent directories if needed
			const parentUri = URI.file(path.dirname(resolvedDest));
			try {
				await this.fileService.createFolder(parentUri);
			} catch {
				// Parent may already exist
			}

			await this.fileService.move(sourceUri, destUri, true);
			this.cache.invalidate(resolvedSource);
			this.cache.invalidate(resolvedDest);
			return { content: `Moved ${source} to ${destination}`, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 6. create_directory
	async createDirectory(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const dirPath = String(args.path ?? '');
			const resolvedPath = this.validatePath(dirPath);
			const dirUri = URI.file(resolvedPath);

			await this.fileService.createFolder(dirUri);
			return { content: `Created directory ${dirPath}`, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 7. list_directory — enhanced with sizes, junk filtering, deep recursion, tree format
	async listDirectory(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const dirPath = String(args.path ?? '.');
			const resolvedPath = this.validatePath(dirPath);
			const dirUri = URI.file(resolvedPath);
			const recursive = args.recursive === 'true' || args.recursive === true;

			const stat = await this.fileService.resolve(dirUri, { resolveMetadata: true });
			if (!stat.isDirectory) {
				throw new QicError('QIC-P001', `Not a directory: ${dirPath}`);
			}

			const results: string[] = [];
			const children = stat.children ?? [];

			// Sort: directories first, then files, alphabetically within each group
			const sorted = [...children].sort((a, b) => {
				if (a.isDirectory && !b.isDirectory) return -1;
				if (!a.isDirectory && b.isDirectory) return 1;
				return a.name.localeCompare(b.name);
			});

			if (recursive) {
				await this.buildTree(sorted, results, '', 0);
			} else {
				for (const entry of sorted) {
					if (entry.isDirectory) {
						if (IGNORED_DIRS.has(entry.name)) {
							results.push(`${entry.name}/ (ignored)`);
						} else {
							results.push(`${entry.name}/`);
						}
					} else {
						const size = entry.size !== undefined ? formatFileSize(entry.size) : '';
						results.push(size ? `${entry.name} (${size})` : entry.name);
					}
				}
			}

			return { content: results.join('\n') || '(empty directory)', isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	/**
	 * Build a tree-formatted directory listing with depth limit and junk filtering.
	 */
	private async buildTree(
		entries: Array<{ name: string; isDirectory: boolean; resource: URI; size?: number }>,
		results: string[],
		indent: string,
		depth: number,
	): Promise<void> {
		for (let i = 0; i < entries.length; i++) {
			const entry = entries[i];
			const isLast = i === entries.length - 1;
			const connector = isLast ? '└── ' : '├── ';

			if (entry.isDirectory) {
				if (IGNORED_DIRS.has(entry.name)) {
					results.push(`${indent}${connector}${entry.name}/ (ignored)`);
					continue;
				}
				results.push(`${indent}${connector}${entry.name}/`);

				if (depth < MAX_LIST_DEPTH) {
					try {
						const subStat = await this.fileService.resolve(entry.resource, { resolveMetadata: true });
						const subChildren = subStat.children ?? [];
						const subSorted = [...subChildren].sort((a, b) => {
							if (a.isDirectory && !b.isDirectory) return -1;
							if (!a.isDirectory && b.isDirectory) return 1;
							return a.name.localeCompare(b.name);
						});
						const nextIndent = indent + (isLast ? '    ' : '│   ');
						await this.buildTree(subSorted, results, nextIndent, depth + 1);
					} catch {
						// Skip inaccessible subdirectories
					}
				}
			} else {
				const size = entry.size !== undefined ? formatFileSize(entry.size) : '';
				results.push(size ? `${indent}${connector}${entry.name} (${size})` : `${indent}${connector}${entry.name}`);
			}
		}
	}

	/**
	 * XI-SV2: Path validation - ensures path is within workspace.
	 * Note: Symlink resolution is handled by IFileService internally.
	 */
	private validatePath(requestedPath: string): string {
		// Reject null bytes — can cause path truncation at filesystem level
		if (requestedPath.includes('\0')) {
			throw new QicError('QIC-P001', `Path contains null bytes: ${requestedPath.replace(/\0/g, '\\0')}`);
		}

		const resolved = path.resolve(this.workspaceRoot, requestedPath);
		if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + path.sep)) {
			throw new QicError('QIC-P001', `Path outside workspace: ${requestedPath}`);
		}

		return resolved;
	}
}
