/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolRouter } from '../runtime/toolRouter.js';
import type { FileOperationTools } from './fileOps.js';
import type { SearchTools } from './searchTools.js';
import type { ReferenceTools } from './referenceTools.js';
import type { TerminalTools } from './terminalTools.js';
import type { NetworkTools } from './networkTools.js';
import type { PackageTools } from './packageTools.js';
import type { LspTools } from './lspTools.js';
import type { NotebookTools } from './notebookTools.js';
import type { CheckpointTools } from './checkpointTools.js';
import type { GitTools } from './gitTools.js';

/**
 * Register all 23 tools with the ToolRouter (Audit X-PS2).
 *
 * Tool numbering follows canonical spec:
 *  1-7:   File operations (FileOperationTools)
 *  8-9:   Search (SearchTools)
 *  10-11: References (ReferenceTools)
 *  12-13: Terminal (TerminalTools)
 *  14-15: Network (NetworkTools)
 *  16:    Package (PackageTools)
 *  17-19: LSP (LspTools)
 *  20-22: Notebook (NotebookTools)
 *  23:    Checkpoint (CheckpointTools)
 */
export function registerAllTools(
	router: ToolRouter,
	deps: {
		fileOps: FileOperationTools;
		search: SearchTools;
		reference: ReferenceTools;
		terminal: TerminalTools;
		network: NetworkTools;
		packages: PackageTools;
		lsp: LspTools;
		notebook: NotebookTools;
		checkpoint: CheckpointTools;
		git: GitTools;
	},
): void {
	// 1-7: File operations
	router.register('read_file', (args) => deps.fileOps.readFile(args));
	router.register('write_file', (args) => deps.fileOps.writeFile(args));
	router.register('edit_file', (args) => deps.fileOps.editFile(args));
	router.register('delete_file', (args) => deps.fileOps.deleteFile(args));
	router.register('move_file', (args) => deps.fileOps.moveFile(args));
	router.register('create_directory', (args) => deps.fileOps.createDirectory(args));
	router.register('list_directory', (args) => deps.fileOps.listDirectory(args));

	// 7-8: Search
	router.register('search_code', (args) => deps.search.searchCode(args));
	router.register('search_files', (args) => deps.search.searchFiles(args));

	// 9-10: References
	router.register('get_references', (args) => deps.reference.getReferences(args));
	router.register('get_definition', (args) => deps.reference.getDefinition(args));

	// 11-12: Terminal
	router.register('run_terminal', (args, ctx) => deps.terminal.runTerminal(args, ctx));
	router.register('run_command', (args, ctx) => deps.terminal.runCommand(args, ctx));

	// 13-14: Network
	router.register('web_fetch', (args) => deps.network.webFetch(args));
	router.register('web_search', (args) => deps.network.webSearch(args));

	// 15: Package
	router.register('install_package', (args, ctx) => deps.packages.installPackage(args, ctx));

	// 16-18: LSP
	router.register('rename_symbol', (args) => deps.lsp.renameSymbol(args));
	router.register('apply_code_action', (args) => deps.lsp.applyCodeAction(args));
	router.register('organize_imports', (args) => deps.lsp.organizeImports(args));

	// 19-21: Notebook
	router.register('inspect_notebook', (args) => deps.notebook.inspectNotebook(args));
	router.register('preview_dataframe', (args) => deps.notebook.previewDataframe(args));
	router.register('analyze_backtest', (args) => deps.notebook.analyzeBacktest(args));

	// 22-24: Git
	router.register('git_status', (args) => deps.git.gitStatus(args));
	router.register('git_diff', (args) => deps.git.gitDiff(args));
	router.register('git_log', (args) => deps.git.gitLog(args));

	// 25: Checkpoint
	router.register('create_checkpoint', (args) => deps.checkpoint.createCheckpoint(args));
}
