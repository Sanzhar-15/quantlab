/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import type { LaneName } from '../canonical/lanes.js';
import { PROMPT_TEMPLATES, RESPONSE_STYLE_MODIFIERS } from '../canonical/prompts.js';
import { tokenCounter } from '../canonical/tokenCounter.js';
import type { IncrementalIndexer } from './incrementalIndexer.js';
import type { Message } from '../canonical/types.js';
import type { ResponseStyle } from '../constants.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import { type IMarkerService, MarkerSeverity } from '../../../../../platform/markers/common/markers.js';

export interface ContextBudget {
	total: number;
	system: number;
	context: number;
	query: number;
	reserve: number;
	contextPriority?: string;
}

export interface AssembledContext {
	systemPrompt: string;
	contextMessages: Message[];
	tokenUsage: {
		system: number;
		context: number;
		query: number;
		total: number;
		remaining: number;
	};
}

export interface ContextOptions {
	activeFile?: string;
	activeFileContent?: string;
	selectedText?: string;
	recentFiles?: string[];
	responseStyle?: ResponseStyle;
	/** If true, skip expensive operations (workspace tree, search) -- used for context refresh between rounds */
	lightweight?: boolean;
}

const SKIP_DIRS = new Set([
	'node_modules', '.git', '__pycache__', '.next', 'dist', 'build',
	'.venv', 'venv', 'coverage', '.cache', '.tox', '.mypy_cache',
	'.pytest_cache', '.eggs', '.ruff_cache', 'out', 'out-build', 'out-vscode',
]);

const MAX_TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 200;
const WORKSPACE_TREE_CACHE_TTL_MS = 30_000; // 30 seconds

/**
 * Lane-specific token budgets.
 * chat-act has a larger context budget to support complex multi-file tasks.
 */
const LANE_BUDGETS: Record<LaneName, ContextBudget> = {
	'chat-ask': { total: 32_768, system: 4096, context: 18_432, query: 4096, reserve: 6144 },
	'chat-gather': { total: 65_536, system: 4096, context: 43_008, query: 8192, reserve: 10_240 },
	'chat-plan': { total: 65_536, system: 4096, context: 43_008, query: 8192, reserve: 10_240 },
	'chat-act': { total: 65_536, system: 4096, context: 43_008, query: 8192, reserve: 10_240 },
	'repair': { total: 32_768, system: 3072, context: 19_456, query: 4096, reserve: 6144, contextPriority: 'error' },
	'fast-apply': { total: 8192, system: 1024, context: 4608, query: 1024, reserve: 1536 },
	'summarize': { total: 32_768, system: 2048, context: 20_480, query: 4096, reserve: 6144, contextPriority: 'conversation-history' },
	'completion': { total: 4096, system: 512, context: 2048, query: 512, reserve: 1024 },
};

/**
 * Context assembly with rich workspace awareness.
 *
 * Provides the model with:
 * 1. System prompt (lane-specific behavioral instructions)
 * 2. Workspace file tree (auto-generated, cached)
 * 3. Active file content (when available)
 * 4. Selected text (when available)
 * 5. BM25 search context (semantically relevant files)
 */
export class ContextAssembler {
	private workspaceTreeCache: { tree: string; generatedAt: number } | null = null;

	constructor(
		private readonly indexer: IncrementalIndexer,
		private readonly fileService?: IFileService,
		private readonly workspaceRoot?: string,
		private readonly markerService?: IMarkerService,
	) { }

	async assemble(
		lane: LaneName,
		userMessage: string,
		options?: ContextOptions,
	): Promise<AssembledContext> {
		const budget = LANE_BUDGETS[lane];

		// System prompt with optional response style modifier
		let systemPrompt = PROMPT_TEMPLATES[lane] ?? PROMPT_TEMPLATES['chat-ask'];

		// Override system prompt for strategy generation requests
		if (this.isStrategyGenerationRequest(userMessage, lane)) {
			systemPrompt = PROMPT_TEMPLATES['strategy-generation'] ?? systemPrompt;
		}

		// Inject response style modifier for conversational lanes
		if (options?.responseStyle && lane.startsWith('chat-')) {
			const modifier = RESPONSE_STYLE_MODIFIERS[options.responseStyle];
			if (modifier) {
				systemPrompt = `${systemPrompt}\n\n## Response Style\n${modifier}`;
			}
		}

		const systemTokens = tokenCounter.count(systemPrompt);
		const queryTokens = tokenCounter.count(userMessage);

		// Available context budget
		const contextBudget = budget.context;
		const contextMessages: Message[] = [];
		let contextTokens = 0;

		// --- 1. Workspace file tree (highest priority for orientation) ---
		if (!options?.lightweight && this.fileService && this.workspaceRoot && lane !== 'completion' && lane !== 'fast-apply') {
			const tree = await this.getWorkspaceTree();
			if (tree) {
				const treeCtx = `[Workspace structure]\n${tree}`;
				const treeTokens = tokenCounter.count(treeCtx);
				if (contextTokens + treeTokens <= contextBudget * 0.3) { // Cap tree at 30% of budget
					contextMessages.push({ role: 'system', content: treeCtx });
					contextTokens += treeTokens;
				}
			}
		}

		// --- 2. Active file content (critical for edit tasks) ---
		if (options?.activeFile) {
			let fileContent = options.activeFileContent;

			// Read file content if not provided but path is available
			if (!fileContent && this.fileService) {
				fileContent = await this.readFileContent(options.activeFile) ?? undefined;
			}

			if (fileContent) {
				// Include with line numbers for precise reference
				const lines = fileContent.split('\n');
				const maxLines = 300; // Cap active file at 300 lines in context
				const truncated = lines.length > maxLines;
				const displayLines = truncated ? lines.slice(0, maxLines) : lines;
				const numbered = displayLines.map((line, i) => `${String(i + 1).padStart(4)} | ${line}`).join('\n');
				const suffix = truncated ? `\n... (${lines.length - maxLines} more lines -- use read_file with startLine/endLine)` : '';
				const activeCtx = `[Active file: ${options.activeFile} -- ${lines.length} lines]\n${numbered}${suffix}`;
				const activeTokens = tokenCounter.count(activeCtx);

				if (contextTokens + activeTokens <= contextBudget * 0.6) { // Cap at 60% of budget
					contextMessages.push({ role: 'system', content: activeCtx });
					contextTokens += activeTokens;
				}
			} else {
				// Fallback: just the filename
				const activeCtx = `[Active file: ${options.activeFile}]`;
				const activeTokens = tokenCounter.count(activeCtx);
				if (contextTokens + activeTokens <= contextBudget) {
					contextMessages.push({ role: 'system', content: activeCtx });
					contextTokens += activeTokens;
				}
			}
		}

		// --- 3. Selected text context ---
		if (options?.selectedText) {
			const selectedCtx = `[Selected text]\n${options.selectedText}`;
			const selectedTokens = tokenCounter.count(selectedCtx);
			if (contextTokens + selectedTokens <= contextBudget) {
				contextMessages.push({ role: 'system', content: selectedCtx });
				contextTokens += selectedTokens;
			}
		}

		// --- 4. Diagnostics (errors/warnings) for active file and workspace ---
		if (!options?.lightweight && this.markerService && lane !== 'completion' && lane !== 'fast-apply') {
			const diagnosticsCtx = this.formatDiagnostics(options?.activeFile);
			if (diagnosticsCtx) {
				const diagTokens = tokenCounter.count(diagnosticsCtx);
				if (contextTokens + diagTokens <= contextBudget * 0.15) { // Cap at 15% of budget
					contextMessages.push({ role: 'system', content: diagnosticsCtx });
					contextTokens += diagTokens;
				}
			}
		}

		// --- 5. BM25 search-based context (fill remaining budget) ---
		if (!options?.lightweight && contextTokens < contextBudget && userMessage.length > 5 && lane !== 'completion') {
			try {
				const searchResults = await this.indexer.search(userMessage, {
					maxResults: 10,
					includeVector: true,
				});

				for (const result of searchResults) {
					const resultText = `[${result.filePath}]\n${result.content}`;
					const resultTokens = tokenCounter.count(resultText);
					if (contextTokens + resultTokens > contextBudget) { break; }
					contextMessages.push({ role: 'system', content: resultText });
					contextTokens += resultTokens;
				}
			} catch {
				// Context search failed -- proceed without it
			}
		}

		const total = systemTokens + contextTokens + queryTokens;

		return {
			systemPrompt,
			contextMessages,
			tokenUsage: {
				system: systemTokens,
				context: contextTokens,
				query: queryTokens,
				total,
				remaining: budget.total - total - budget.reserve,
			},
		};
	}

	getBudget(lane: LaneName): ContextBudget {
		return LANE_BUDGETS[lane];
	}

	/**
	 * Invalidate workspace tree cache (call after file operations).
	 */
	invalidateTreeCache(): void {
		this.workspaceTreeCache = null;
	}

	// --- Private helpers ---

	/**
	 * Generate a workspace file tree (cached for 30 seconds).
	 * Shows directories and files up to MAX_TREE_DEPTH levels deep.
	 */
	private async getWorkspaceTree(): Promise<string | null> {
		if (!this.fileService || !this.workspaceRoot) { return null; }

		// Check cache
		if (this.workspaceTreeCache && (Date.now() - this.workspaceTreeCache.generatedAt) < WORKSPACE_TREE_CACHE_TTL_MS) {
			return this.workspaceTreeCache.tree;
		}

		try {
			const lines: string[] = [];
			await this.buildTree(this.workspaceRoot, lines, '', 0);

			if (lines.length === 0) { return null; }

			const tree = lines.join('\n');
			this.workspaceTreeCache = { tree, generatedAt: Date.now() };
			return tree;
		} catch {
			return null;
		}
	}

	private async buildTree(
		dir: string,
		lines: string[],
		prefix: string,
		depth: number,
	): Promise<void> {
		if (depth > MAX_TREE_DEPTH || lines.length >= MAX_TREE_ENTRIES) { return; }

		try {
			const dirUri = URI.file(dir);
			const stat = await this.fileService!.resolve(dirUri, { resolveMetadata: false });

			if (!stat.isDirectory || !stat.children) { return; }

			// Sort: directories first, then files, alphabetical within each group
			const entries = [...stat.children].sort((a, b) => {
				if (a.isDirectory !== b.isDirectory) { return a.isDirectory ? -1 : 1; }
				return a.name.localeCompare(b.name);
			});

			for (let i = 0; i < entries.length; i++) {
				if (lines.length >= MAX_TREE_ENTRIES) { break; }

				const entry = entries[i];
				const isLast = i === entries.length - 1;
				const connector = isLast ? '`-- ' : '|-- ';
				const childPrefix = isLast ? '    ' : '|   ';

				if (entry.isDirectory) {
					if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) {
						continue;
					}
					lines.push(`${prefix}${connector}${entry.name}/`);
					const fullPath = path.join(dir, entry.name);
					await this.buildTree(fullPath, lines, prefix + childPrefix, depth + 1);
				} else {
					lines.push(`${prefix}${connector}${entry.name}`);
				}
			}
		} catch {
			// Skip inaccessible directories
		}
	}

	/**
	 * Format diagnostics (errors/warnings) for context.
	 * Prioritizes active file diagnostics, then adds workspace-wide errors.
	 */
	private formatDiagnostics(activeFile?: string): string | null {
		if (!this.markerService) { return null; }

		const lines: string[] = [];
		const severityLabel = (s: MarkerSeverity) =>
			s === MarkerSeverity.Error ? 'ERROR' :
				s === MarkerSeverity.Warning ? 'WARNING' :
					s === MarkerSeverity.Info ? 'INFO' : 'HINT';

		// Active file diagnostics (errors + warnings only)
		if (activeFile && this.workspaceRoot) {
			const resolvedPath = path.isAbsolute(activeFile)
				? activeFile
				: path.join(this.workspaceRoot, activeFile);
			const uri = URI.file(resolvedPath);
			const markers = this.markerService.read({ resource: uri })
				.filter(m => m.severity === MarkerSeverity.Error || m.severity === MarkerSeverity.Warning)
				.slice(0, 20);

			if (markers.length > 0) {
				lines.push(`[Diagnostics: ${activeFile}]`);
				for (const m of markers) {
					lines.push(`  L${m.startLineNumber}: (${severityLabel(m.severity)}) ${m.message}`);
				}
			}
		}

		// Workspace-wide error summary (other files with errors)
		const stats = this.markerService.getStatistics();
		if (stats.errors > 0) {
			const allErrors = this.markerService.read({ severities: MarkerSeverity.Error, take: 30 });
			// Group by file, skip active file (already shown)
			const byFile = new Map<string, number>();
			for (const m of allErrors) {
				const filePath = m.resource.fsPath;
				if (activeFile && this.workspaceRoot) {
					const resolvedActive = path.isAbsolute(activeFile)
						? activeFile
						: path.join(this.workspaceRoot, activeFile);
					if (filePath === resolvedActive) { continue; }
				}
				const rel = this.workspaceRoot ? path.relative(this.workspaceRoot, filePath) : filePath;
				byFile.set(rel, (byFile.get(rel) ?? 0) + 1);
			}

			if (byFile.size > 0) {
				lines.push(`[Workspace errors: ${stats.errors} total across ${byFile.size + (lines.length > 0 ? 1 : 0)} files]`);
				for (const [file, count] of [...byFile.entries()].slice(0, 10)) {
					lines.push(`  ${file}: ${count} error${count > 1 ? 's' : ''}`);
				}
			}
		}

		return lines.length > 0 ? lines.join('\n') : null;
	}

	/**
	 * Read file content via IFileService. Returns null if unreadable.
	 */
	private async readFileContent(filePath: string): Promise<string | null> {
		if (!this.fileService || !this.workspaceRoot) { return null; }

		try {
			const resolvedPath = path.isAbsolute(filePath)
				? filePath
				: path.join(this.workspaceRoot, filePath);
			const uri = URI.file(resolvedPath);
			const content = await this.fileService.readFile(uri);
			return content.value.toString();
		} catch {
			return null;
		}
	}

	/**
	 * Detect if the user is requesting strategy generation.
	 * Only override for chat-act and chat-ask lanes where code generation happens.
	 */
	private isStrategyGenerationRequest(userMessage: string, lane: LaneName): boolean {
		// Only apply to conversational lanes where strategy generation is likely
		if (lane !== 'chat-act' && lane !== 'chat-ask') {
			return false;
		}

		const lowerMessage = userMessage.toLowerCase();

		// Strategy creation keywords
		const creationKeywords = [
			'create a strategy',
			'create strategy',
			'build a strategy',
			'build strategy',
			'write a strategy',
			'write strategy',
			'generate a strategy',
			'generate strategy',
			'make a strategy',
			'make strategy',
			'develop a strategy',
			'develop strategy',
			'implement a strategy',
			'implement strategy',
		];

		// Trading strategy indicators
		const strategyIndicators = [
			'trading strategy',
			'backtesting strategy',
			'quantlab strategy',
			'sma strategy',
			'rsi strategy',
			'macd strategy',
			'momentum strategy',
			'crossover strategy',
			'mean reversion',
			'trend following',
			'moving average',
			'bollinger band',
		];

		// Check for creation keywords
		for (const keyword of creationKeywords) {
			if (lowerMessage.includes(keyword)) {
				return true;
			}
		}

		// Check for strategy indicators combined with action verbs
		// ('fix'/'repair' cover Fix-with-Orion flows: corrections to an existing
		// strategy need the same API contract as fresh generation)
		const actionVerbs = ['create', 'build', 'write', 'make', 'generate', 'develop', 'implement', 'code', 'fix', 'repair'];
		for (const indicator of strategyIndicators) {
			if (lowerMessage.includes(indicator)) {
				for (const verb of actionVerbs) {
					if (lowerMessage.includes(verb)) {
						return true;
					}
				}
			}
		}

		return false;
	}
}
