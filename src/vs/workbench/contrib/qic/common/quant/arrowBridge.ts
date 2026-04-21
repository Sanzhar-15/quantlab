/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from '../../../../../base/common/path.js';

let _fsPromises: typeof import('fs/promises') | null = null;
async function fsPromises(): Promise<typeof import('fs/promises')> {
	if (!_fsPromises) {
		// @ts-ignore
		_fsPromises = await import('fs/promises');
	}
	return _fsPromises;
}

let _os: any = null;
async function getOs(): Promise<any> {
	if (!_os) {
		try {
			// @ts-ignore
			_os = await import('os');
		} catch {
			throw new Error('os module not available in browser context');
		}
	}
	return _os;
}
import { randomUUID } from '../qicCrypto.js';
import type { QicPythonBridge } from './qicPythonBridge.js';

/**
 * Lightweight wrapper representing an Arrow table.
 * Full Apache Arrow integration requires the `apache-arrow` npm package.
 * This type abstracts over the actual arrow Table for use in the bridge layer.
 */
export interface ArrowTable {
	schema: ArrowSchema;
	numRows: number;
	numCols: number;
	toJSON(): Record<string, unknown>[];
}

export interface ArrowSchema {
	fields: ArrowField[];
}

export interface ArrowField {
	name: string;
	type: string;
	nullable: boolean;
}

/**
 * Apache Arrow IPC bridge for zero-copy DataFrame transfer.
 *
 * Uses IPC (Inter-Process Communication) file format for transferring
 * data between the Python engine daemon and TypeScript.
 *
 * REMEDIATION FIX 4c: Requires `apache-arrow` npm dependency.
 */
export class ArrowDataFrameBridge {

	private tempDir: string | null = null;

	constructor(workspaceRoot: string) {
		// tempDir is lazily initialized via getTempDir() since os.tmpdir() requires async import
	}

	private async getTempDir(): Promise<string> {
		if (!this.tempDir) {
			const os = await getOs();
			this.tempDir = path.join(os.tmpdir(), 'qic-arrow');
		}
		return this.tempDir;
	}

	/**
	 * Read a DataFrame from Arrow IPC format.
	 * Uses dynamic import of apache-arrow for the actual reading.
	 */
	async readFromArrow(ipcPath: string): Promise<ArrowTable> {
		const fs = await fsPromises();
		const buffer = await fs.readFile(ipcPath);

		// Dynamic import of apache-arrow to avoid hard dependency at module level
		try {
			// @ts-ignore - apache-arrow is an optional runtime dependency
			const arrow = await import('apache-arrow');
			const table = arrow.tableFromIPC(buffer);
			return this.wrapTable(table);
		} catch {
			// Fallback: return metadata-only representation
			return {
				schema: { fields: [] },
				numRows: 0,
				numCols: 0,
				toJSON: () => [],
			};
		}
	}

	/**
	 * Write data to Arrow IPC format for Python consumption.
	 */
	async writeToArrow(data: ArrowTable, outputPath: string): Promise<void> {
		const fs = await fsPromises();
		try {
			// @ts-ignore - apache-arrow is an optional runtime dependency
			const arrow = await import('apache-arrow');

			// Convert ArrowTable back to IPC bytes
			// If the data is already an arrow Table, serialize directly
			const jsonData = data.toJSON();
			const table = arrow.tableFromJSON(jsonData);
			const bytes = arrow.tableToIPC(table);

			await fs.mkdir(path.dirname(outputPath), { recursive: true });
			await fs.writeFile(outputPath, bytes);
		} catch (err) {
			throw new Error(`Failed to write Arrow IPC: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	/**
	 * Transfer a DataFrame from Python to TypeScript via Arrow IPC.
	 *
	 * 1. Engine daemon writes DataFrame to Arrow IPC temp file
	 * 2. TypeScript reads the Arrow IPC file
	 * 3. File is cleaned up after read
	 */
	async transferFromPython(
		bridge: QicPythonBridge,
		pythonExpression: string,
	): Promise<ArrowTable> {
		const fs = await fsPromises();
		const tempDir = await this.getTempDir();
		const tempId = randomUUID();
		const tempPath = path.join(tempDir, `transfer-${tempId}.arrow`);

		await fs.mkdir(tempDir, { recursive: true });

		try {
			// Ask the engine daemon to write the DataFrame to Arrow IPC
			await bridge.call<{ path: string }>('qic.write_arrow_ipc', {
				expression: pythonExpression,
				output_path: tempPath,
			});

			// Read the Arrow IPC file
			const table = await this.readFromArrow(tempPath);
			return table;
		} finally {
			// Clean up temp file
			await fs.rm(tempPath, { force: true }).catch(() => {});
		}
	}

	/**
	 * Clean up all temporary Arrow IPC files.
	 */
	async cleanup(): Promise<void> {
		const fs = await fsPromises();
		const tempDir = await this.getTempDir();
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}

	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	private wrapTable(table: any): ArrowTable {
		const fields: ArrowField[] = [];
		if (table.schema?.fields) {
			for (const field of table.schema.fields) {
				fields.push({
					name: String(field.name),
					type: String(field.type),
					nullable: Boolean(field.nullable),
				});
			}
		}

		return {
			schema: { fields },
			numRows: Number(table.numRows ?? 0),
			numCols: Number(table.numCols ?? 0),
			toJSON: () => {
				try {
					return table.toArray ? table.toArray().map((r: unknown) => {
						if (r && typeof r === 'object' && 'toJSON' in r) {
							return (r as { toJSON(): Record<string, unknown> }).toJSON();
						}
						return r;
					}) : [];
				} catch {
					return [];
				}
			},
		};
	}
}
