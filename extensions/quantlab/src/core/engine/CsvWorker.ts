/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * CSV Worker (CODEX-012).
 *
 * Parses CSV files in a worker thread to avoid blocking the extension host.
 */

import { Worker, isMainThread, parentPort, workerData } from 'worker_threads';
import * as fs from 'fs';

if (!isMainThread && parentPort) {
	// Worker thread: parse CSV
	const { filePath } = workerData as { filePath: string };
	const content = fs.readFileSync(filePath, 'utf-8');
	const lines = content.split('\n');
	const headers = lines[0].split(',').map((h: string) => h.trim());

	const records: Record<string, string | number>[] = [];
	for (let i = 1; i < lines.length; i++) {
		if (!lines[i].trim()) { continue; }
		const values = lines[i].split(',');
		const record: Record<string, string | number> = {};
		for (let j = 0; j < headers.length; j++) {
			const val = values[j]?.trim() ?? '';
			const num = Number(val);
			record[headers[j]] = isNaN(num) || val === '' ? val : num;
		}
		records.push(record);
	}

	parentPort.postMessage({ records, rowCount: records.length });
}

export function parseCsvInWorker(
	filePath: string,
): Promise<{ records: Record<string, string | number>[]; rowCount: number }> {
	return new Promise((resolve, reject) => {
		const worker = new Worker(__filename, {
			workerData: { filePath },
		});

		worker.on('message', resolve);
		worker.on('error', reject);
		worker.on('exit', (code) => {
			if (code !== 0) {
				reject(new Error(`CSV worker exited with code ${code}`));
			}
		});
	});
}
