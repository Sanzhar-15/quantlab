/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { HistoryState } from '../../core/state/HistoryState';

type ExportFormat = 'json' | 'csv' | 'html';

export class ResultsExporter {
	constructor(private readonly historyState: HistoryState) { }

	async export(runId: string, format: ExportFormat): Promise<void> {
		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			void vscode.window.showWarningMessage('Run not found.');
			return;
		}

		const result = await this.loadResult(entry.artifactPath);
		const fileUri = await vscode.window.showSaveDialog({
			saveLabel: 'Export Results',
			filters: format === 'json'
				? { JSON: ['json'] }
				: format === 'csv'
					? { CSV: ['csv'] }
					: { HTML: ['html'] }
		});
		if (!fileUri) {
			return;
		}

		const content = this.formatResult(result, format);
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
		void vscode.window.showInformationMessage('Results exported.');
	}

	private async loadResult(artifactPath: string): Promise<Record<string, unknown>> {
		if (!artifactPath) {
			return {};
		}

		try {
			const uri = vscode.Uri.file(artifactPath);
			const resultUri = vscode.Uri.joinPath(uri, 'result.json');
			const data = await vscode.workspace.fs.readFile(resultUri);
			return JSON.parse(Buffer.from(data).toString('utf8')) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private formatResult(result: Record<string, unknown>, format: ExportFormat): string {
		if (format === 'json') {
			return JSON.stringify(result, null, 2);
		}

		if (format === 'csv') {
			const lines = ['metric,value'];
			const metrics = (result.metrics ?? {}) as Record<string, unknown>;
			for (const [key, value] of Object.entries(metrics)) {
				lines.push(`${key},${value}`);
			}
			return lines.join('\n');
		}

		const metrics = (result.metrics ?? {}) as Record<string, unknown>;
		const rows = Object.entries(metrics).map(([key, value]) => `<tr><td>${key}</td><td>${value}</td></tr>`).join('');
		return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Quantlab Results</title></head>
<body>
<h1>Quantlab Results</h1>
<table border="1" cellpadding="6" cellspacing="0">
<tr><th>Metric</th><th>Value</th></tr>
${rows}
</table>
</body>
</html>`;
	}
}
