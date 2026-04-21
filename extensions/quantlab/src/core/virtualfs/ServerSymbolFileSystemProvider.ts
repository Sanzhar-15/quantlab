/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

/**
 * Virtual file system provider for server symbols.
 * Allows opening server symbols as tabs with URI format: quantlab-server://symbol/APEX.py
 */
export class ServerSymbolFileSystemProvider implements vscode.FileSystemProvider {
	private readonly _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
	readonly onDidChangeFile = this._onDidChangeFile.event;

	/**
	 * Get file stats for a server symbol URI
	 */
	stat(uri: vscode.Uri): vscode.FileStat {
		return {
			type: vscode.FileType.File,
			ctime: Date.now(),
			mtime: Date.now(),
			size: this.generateContent(uri).length
		};
	}

	/**
	 * Read file content - generates template for server symbol
	 */
	readFile(uri: vscode.Uri): Uint8Array {
		const content = this.generateContent(uri);
		return Buffer.from(content, 'utf8');
	}

	/**
	 * Generate template content for server symbol
	 */
	private generateContent(uri: vscode.Uri): string {
		const symbol = uri.path.replace('/symbol/', '').replace(/\.py$/, '');
		return `# Server Symbol: ${symbol}
# Data Source: Delta Plus Server
#
# This is a virtual file representing the server symbol ${symbol}.
# Charts, Actions, and Stats views will use live server data.

import quantlab as ql

def strategy(data):
	"""Your strategy logic here."""
	# Example: Simple moving average crossover
	# sma_fast = ql.sma(data.close, 10)
	# sma_slow = ql.sma(data.close, 50)
	pass
`;
	}

	// Required FileSystemProvider methods - stubs for read-only virtual FS

	readDirectory(): [string, vscode.FileType][] {
		return [];
	}

	createDirectory(): void {
		throw vscode.FileSystemError.NoPermissions('Server symbols are read-only');
	}

	writeFile(): void {
		// Note: Could implement to persist edits to workspace state in future
		throw vscode.FileSystemError.NoPermissions('Server symbols are read-only');
	}

	delete(): void {
		throw vscode.FileSystemError.NoPermissions('Server symbols cannot be deleted');
	}

	rename(): void {
		throw vscode.FileSystemError.NoPermissions('Server symbols cannot be renamed');
	}

	watch(): vscode.Disposable {
		// No-op watcher since content is static
		return { dispose: () => {} };
	}
}
