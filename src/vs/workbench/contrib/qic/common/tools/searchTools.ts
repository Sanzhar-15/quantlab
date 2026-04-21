/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ToolResultPayload } from '../canonical/types.js';
import type { IncrementalIndexer } from '../context/incrementalIndexer.js';

const SKIP_DIRS = new Set([
	'node_modules', '.git', '__pycache__', '.next', 'dist', 'build',
	'.venv', 'venv', 'coverage', '.cache', '.tox', '.mypy_cache',
	'.pytest_cache', '.eggs', '.ruff_cache', 'out', 'out-build', 'out-vscode',
]);

const BINARY_EXTENSIONS = new Set([
	'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.svg',
	'.woff', '.woff2', '.ttf', '.eot', '.otf',
	'.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
	'.pdf', '.doc', '.docx', '.xls', '.xlsx', '.pptx',
	'.exe', '.dll', '.so', '.dylib', '.o', '.a',
	'.pyc', '.pyo', '.class', '.wasm',
	'.mp3', '.mp4', '.avi', '.mov', '.flac', '.wav',
	'.sqlite', '.db', '.sqlite3',
]);

const MAX_FILE_SIZE = 512 * 1024; // 512KB — skip files larger than this
const MAX_FILES_TO_SEARCH = 5000;
const CONTEXT_LINES = 2; // Lines of context above/below each match

interface SearchMatch {
	filePath: string;
	lineNumber: number;
	lineContent: string;
	contextBefore: string[];
	contextAfter: string[];
}

/**
 * Search tools (2 tools): search_code, search_files.
 *
 * search_code: Real regex/literal search across workspace files.
 * Returns matched lines with line numbers and surrounding context.
 *
 * search_files: Find files by name/glob pattern.
 */
export class SearchTools {

	constructor(
		_indexer: IncrementalIndexer,
		private readonly workspaceRoot: string,
		private readonly fileService: IFileService,
	) {}

	/**
	 * search_code — Real regex search with line numbers and context.
	 * Searches file contents across the workspace using regex or literal matching.
	 * Returns matched lines with surrounding context, grouped by file.
	 */
	async searchCode(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const query = String(args.query ?? '');
			if (!query) {
				return { content: 'Error: query is required', isError: true };
			}

			const maxResults = Math.min(Number(args.maxResults) || 50, 200);
			const includeGlob = args.include ? String(args.include) : undefined;
			const excludeGlob = args.exclude ? String(args.exclude) : undefined;

			// Build regex — treat as literal if regex syntax errors
			let regex: RegExp;
			try {
				regex = new RegExp(query, 'gi');
			} catch {
				// Escape as literal string if regex is invalid
				const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
				regex = new RegExp(escaped, 'gi');
			}

			// Collect files to search
			const files = await this.collectFiles(
				this.workspaceRoot,
				includeGlob ? this.globToRegex(includeGlob) : undefined,
				excludeGlob ? this.globToRegex(excludeGlob) : undefined,
			);

			// Search each file for matches
			const allMatches: SearchMatch[] = [];
			let filesSearched = 0;

			for (const filePath of files) {
				if (allMatches.length >= maxResults) { break; }

				const content = await this.readFileContent(filePath);
				if (content === null) { continue; }
				filesSearched++;

				const lines = content.split('\n');
				for (let i = 0; i < lines.length; i++) {
					regex.lastIndex = 0;
					if (regex.test(lines[i])) {
						allMatches.push({
							filePath: path.relative(this.workspaceRoot, filePath),
							lineNumber: i + 1,
							lineContent: lines[i],
							contextBefore: lines.slice(Math.max(0, i - CONTEXT_LINES), i),
							contextAfter: lines.slice(i + 1, Math.min(lines.length, i + 1 + CONTEXT_LINES)),
						});

						if (allMatches.length >= maxResults) { break; }
					}
				}
			}

			if (allMatches.length === 0) {
				return { content: `No matches found for "${query}" (searched ${filesSearched} files)`, isError: false };
			}

			// Format results grouped by file
			const formatted = this.formatSearchResults(allMatches, filesSearched);
			return { content: formatted, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 8. search_files
	async searchFiles(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const pattern = String(args.pattern ?? '');
			if (!pattern) {
				return { content: 'Error: pattern is required', isError: true };
			}

			const directory = args.directory ? String(args.directory) : this.workspaceRoot;
			const resolvedDir = path.resolve(this.workspaceRoot, directory);

			if (resolvedDir !== this.workspaceRoot && !resolvedDir.startsWith(this.workspaceRoot + path.sep)) {
				return { content: 'Error: directory outside workspace', isError: true };
			}

			const matches = await this.findFiles(resolvedDir, pattern);
			if (matches.length === 0) {
				return { content: `No files matching '${pattern}' found`, isError: false };
			}

			const relative = matches.map(f => path.relative(this.workspaceRoot, f));
			return { content: relative.join('\n'), isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	/**
	 * Format search results grouped by file with line numbers and context.
	 * Output format:
	 *   file.py (3 matches)
	 *     10 |     def calculate(self):
	 *     11 |         return self.value * 2   <-- match
	 *     12 |
	 */
	private formatSearchResults(matches: SearchMatch[], filesSearched: number): string {
		// Group by file
		const byFile = new Map<string, SearchMatch[]>();
		for (const m of matches) {
			const existing = byFile.get(m.filePath);
			if (existing) {
				existing.push(m);
			} else {
				byFile.set(m.filePath, [m]);
			}
		}

		const parts: string[] = [];
		parts.push(`Found ${matches.length} match${matches.length === 1 ? '' : 'es'} in ${byFile.size} file${byFile.size === 1 ? '' : 's'} (searched ${filesSearched} files)\n`);

		for (const [filePath, fileMatches] of byFile) {
			parts.push(`${filePath} (${fileMatches.length} match${fileMatches.length === 1 ? '' : 'es'})`);

			for (const m of fileMatches) {
				// Context before
				const startLine = m.lineNumber - m.contextBefore.length;
				for (let i = 0; i < m.contextBefore.length; i++) {
					parts.push(`  ${String(startLine + i).padStart(6)} |  ${m.contextBefore[i]}`);
				}
				// Matched line (marked)
				parts.push(`  ${String(m.lineNumber).padStart(6)} |> ${m.lineContent}`);
				// Context after
				for (let i = 0; i < m.contextAfter.length; i++) {
					parts.push(`  ${String(m.lineNumber + 1 + i).padStart(6)} |  ${m.contextAfter[i]}`);
				}
				parts.push('');
			}
		}

		return parts.join('\n');
	}

	/**
	 * Collect all searchable files in the workspace, respecting include/exclude globs.
	 */
	private async collectFiles(
		dir: string,
		includeRegex?: RegExp,
		excludeRegex?: RegExp,
		files: string[] = [],
		depth: number = 0,
	): Promise<string[]> {
		if (files.length >= MAX_FILES_TO_SEARCH || depth > 15) { return files; }

		try {
			const dirUri = URI.file(dir);
			const stat = await this.fileService.resolve(dirUri, { resolveMetadata: true });

			if (!stat.isDirectory || !stat.children) { return files; }

			for (const entry of stat.children) {
				if (files.length >= MAX_FILES_TO_SEARCH) { break; }

				const fullPath = path.join(dir, entry.name);
				const relativePath = path.relative(this.workspaceRoot, fullPath);

				if (entry.isDirectory) {
					if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
						continue;
					}
					await this.collectFiles(fullPath, includeRegex, excludeRegex, files, depth + 1);
				} else {
					// Skip binary files
					const ext = path.extname(entry.name).toLowerCase();
					if (BINARY_EXTENSIONS.has(ext)) { continue; }

					// Skip large files
					if (entry.size !== undefined && entry.size > MAX_FILE_SIZE) { continue; }

					// Apply include filter (if specified, file must match)
					if (includeRegex && !includeRegex.test(relativePath)) { continue; }

					// Apply exclude filter
					if (excludeRegex && excludeRegex.test(relativePath)) { continue; }

					files.push(fullPath);
				}
			}
		} catch {
			// Skip inaccessible directories
		}
		return files;
	}

	/**
	 * Read file content via IFileService. Returns null if unreadable or binary.
	 */
	private async readFileContent(filePath: string): Promise<string | null> {
		try {
			const uri = URI.file(filePath);
			const fileContent = await this.fileService.readFile(uri);
			const text = fileContent.value.toString();
			// Quick binary check
			if (text.includes('\0')) { return null; }
			return text;
		} catch {
			return null;
		}
	}

	/**
	 * Convert a simple glob pattern to a regex for filtering.
	 * Supports: * (any), ** (any path), ? (single char)
	 */
	private globToRegex(glob: string): RegExp {
		const escaped = glob
			.replace(/[.+^${}()|[\]\\]/g, '\\$&')
			.replace(/\*\*/g, '§GLOBSTAR§')
			.replace(/\*/g, '[^/]*')
			.replace(/§GLOBSTAR§/g, '.*')
			.replace(/\?/g, '.');
		return new RegExp(escaped, 'i');
	}

	private async findFiles(dir: string, pattern: string, results: string[] = []): Promise<string[]> {
		try {
			const dirUri = URI.file(dir);
			const stat = await this.fileService.resolve(dirUri, { resolveMetadata: true });

			if (!stat.isDirectory || !stat.children) {
				return results;
			}

			const escapedPattern = pattern
				.replace(/[.+^${}()|[\]\\]/g, '\\$&')
				.replace(/\*/g, '.*')
				.replace(/\?/g, '.');
			const regex = new RegExp(escapedPattern, 'i');

			for (const entry of stat.children) {
				const fullPath = path.join(dir, entry.name);
				if (entry.isDirectory) {
					if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
						await this.findFiles(fullPath, pattern, results);
					}
				} else if (regex.test(entry.name)) {
					results.push(fullPath);
					if (results.length >= 100) { break; }
				}
			}
		} catch {
			// Skip inaccessible directories
		}
		return results;
	}
}
