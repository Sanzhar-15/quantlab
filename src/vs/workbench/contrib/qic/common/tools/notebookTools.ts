/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';
import { URI } from '../../../../../base/common/uri.js';
import type { IFileService } from '../../../../../platform/files/common/files.js';
import type { ToolResultPayload } from '../canonical/types.js';
import type { QicPythonBridge } from '../quant/qicPythonBridge.js';
import type { DataFrameSafety } from '../quant/dataframeSafety.js';

/**
 * Notebook tools (3 tools): inspect_notebook, preview_dataframe, analyze_backtest.
 *
 * Uses VS Code's IFileService for file system access.
 *
 * Prompt 16 enhancement: Replaces stubs with real implementations
 * using QicPythonBridge (existing engine daemon) and DataFrameSafety.
 */
export class NotebookTools {

	constructor(
		private readonly bridge: QicPythonBridge | null,
		private readonly dataframeSafety: DataFrameSafety | null,
		private readonly workspaceRoot: string,
		private readonly fileService: IFileService,
	) {}

	private validatePath(filePath: string): string {
		const resolved = path.resolve(this.workspaceRoot, filePath);
		if (resolved !== this.workspaceRoot && !resolved.startsWith(this.workspaceRoot + path.sep)) {
			throw new Error(`Path outside workspace: ${filePath}`);
		}
		return resolved;
	}

	// 19. inspect_notebook
	async inspectNotebook(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const notebookPath = String(args.path ?? '');

			if (!notebookPath) {
				return { content: 'Error: path is required', isError: true };
			}

			const validPath = this.validatePath(notebookPath);
			const fileUri = URI.file(validPath);

			// Read and parse .ipynb file
			const contentBuffer = await this.fileService.readFile(fileUri);
			const raw = contentBuffer.value.toString();
			const notebook = JSON.parse(raw);

			const cells = (notebook.cells ?? []) as Array<{
				cell_type: string;
				source: string[];
				outputs?: Array<{ output_type: string; text?: string[] }>;
				execution_count?: number | null;
			}>;

			const summary = {
				totalCells: cells.length,
				codeCells: cells.filter(c => c.cell_type === 'code').length,
				markdownCells: cells.filter(c => c.cell_type === 'markdown').length,
				executedCells: cells.filter(c => c.execution_count != null).length,
				kernelSpec: notebook.metadata?.kernelspec?.display_name ?? 'unknown',
				language: notebook.metadata?.kernelspec?.language ?? notebook.metadata?.language_info?.name ?? 'unknown',
				cells: cells.map((c, i) => ({
					index: i,
					type: c.cell_type,
					lines: Array.isArray(c.source) ? c.source.length : 1,
					executed: c.execution_count != null,
					hasOutput: (c.outputs?.length ?? 0) > 0,
					preview: (Array.isArray(c.source) ? c.source.join('') : String(c.source)).slice(0, 100),
				})),
			};

			return {
				content: JSON.stringify(summary, null, 2),
				isError: false,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 20. preview_dataframe
	async previewDataframe(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			// If a file path is provided, use DataFrameSafety for file-based preview
			const filePath = args.path ? String(args.path) : undefined;
			const variable = args.variable ? String(args.variable) : undefined;
			const maxRows = Number(args.maxRows) || 10;

			if (filePath && this.dataframeSafety) {
				const validFilePath = this.validatePath(filePath);
				const preview = await this.dataframeSafety.preview(validFilePath, { maxRows });
				return {
					content: JSON.stringify(preview, null, 2),
					isError: false,
				};
			}

			if (variable && this.bridge) {
				// Use the bridge to get DataFrame preview from a variable name
				const preview = await this.bridge.call('qic.preview_variable', {
					variable,
					maxRows,
				});
				return {
					content: JSON.stringify(preview, null, 2),
					isError: false,
				};
			}

			if (!filePath && !variable) {
				return { content: 'Error: either path or variable is required', isError: true };
			}

			// Fallback when bridge/safety not available
			return {
				content: JSON.stringify({
					tool: 'preview_dataframe',
					path: filePath,
					variable,
					maxRows,
					note: 'QicPythonBridge not connected. Start the engine daemon for DataFrame preview.',
				}),
				isError: false,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 21. analyze_backtest
	async analyzeBacktest(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const resultsPath = args.path ? String(args.path) : undefined;
			const returns = args.returns as number[] | undefined;
			const benchmark = args.benchmark as number[] | undefined;

			if (!this.bridge) {
				return {
					content: JSON.stringify({
						tool: 'analyze_backtest',
						path: resultsPath,
						note: 'QicPythonBridge not connected. Start the engine daemon for backtest analysis.',
					}),
					isError: false,
				};
			}

			// If returns are directly provided, analyze them
			if (returns && Array.isArray(returns)) {
				const analysis = await this.bridge.analyzeBacktest(returns, benchmark);
				return {
					content: JSON.stringify(analysis, null, 2),
					isError: false,
				};
			}

			// If a file path is provided, load returns from the file via the bridge
			if (resultsPath) {
				const validResultsPath = this.validatePath(resultsPath);
				const analysis = await this.bridge.call('qic.analyze_backtest_file', {
					path: validResultsPath,
					benchmark,
				});
				return {
					content: JSON.stringify(analysis, null, 2),
					isError: false,
				};
			}

			return { content: 'Error: either path or returns array is required', isError: true };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}
}
