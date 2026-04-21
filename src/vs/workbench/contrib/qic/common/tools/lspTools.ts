/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolResultPayload } from '../canonical/types.js';

/**
 * LSP tools (3 tools): rename_symbol, apply_code_action, organize_imports.
 * Delegate to VS Code's language service commands.
 * Full wiring in Prompt 18.
 */
export class LspTools {

	// 16. rename_symbol
	async renameSymbol(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const position = args.position as { line: number; column: number } | undefined;
			const newName = String(args.newName ?? '');

			if (!filePath || !position || !newName) {
				return { content: 'Error: path, position, and newName are required', isError: true };
			}

			// Not yet wired — requires VS Code language service integration (Prompt 18)
			return {
				content: 'rename_symbol is not yet implemented. Requires VS Code language service integration.',
				isError: true,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 17. apply_code_action
	async applyCodeAction(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');
			const range = args.range as { startLine: number; startColumn: number; endLine: number; endColumn: number } | undefined;
			if (!filePath || !range) {
				return { content: 'Error: path and range are required', isError: true };
			}

			// Not yet wired — requires VS Code language service integration (Prompt 18)
			return {
				content: 'apply_code_action is not yet implemented. Requires VS Code language service integration.',
				isError: true,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 18. organize_imports
	async organizeImports(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const filePath = String(args.path ?? '');

			if (!filePath) {
				return { content: 'Error: path is required', isError: true };
			}

			// Not yet wired — requires VS Code language service integration (Prompt 18)
			return {
				content: 'organize_imports is not yet implemented. Requires VS Code language service integration.',
				isError: true,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}
}
