/*---------------------------------------------------------------------------------------------
 *  Export Command
 *  Commands for exporting backtest results
 *
 *  Spec Reference: Technical Spec §17.4, Decision K64
 *---------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { HistoryState } from '../core/state/HistoryState';

/**
 * Export format options.
 */
export type ExportFormat = 'json' | 'csv' | 'html';

/**
 * Backtest result data structure.
 */
interface BacktestResult {
	metrics: Record<string, unknown>;
	trades: Array<Record<string, unknown>>;
	equityCurve?: Array<Record<string, unknown>>;
	parameters?: Record<string, unknown>;
}

/**
 * Export commands handler.
 */
export class ExportCommands {
	private static instance: ExportCommands | undefined;

	private constructor(
		private readonly historyState: HistoryState
	) {}

	static initialize(historyState: HistoryState, _extensionPath?: string): ExportCommands {
		if (!ExportCommands.instance) {
			ExportCommands.instance = new ExportCommands(historyState);
		}
		return ExportCommands.instance;
	}

	static getInstance(): ExportCommands {
		if (!ExportCommands.instance) {
			throw new Error('ExportCommands not initialized');
		}
		return ExportCommands.instance;
	}

	/**
	 * Register all export commands.
	 */
	registerCommands(context: vscode.ExtensionContext): void {
		context.subscriptions.push(
			vscode.commands.registerCommand('quantlab.export.json', (runId?: string) =>
				this.exportWithPicker(runId, 'json')
			),
			vscode.commands.registerCommand('quantlab.export.csv', (runId?: string) =>
				this.exportWithPicker(runId, 'csv')
			),
			vscode.commands.registerCommand('quantlab.export.html', (runId?: string) =>
				this.exportWithPicker(runId, 'html')
			),
			vscode.commands.registerCommand('quantlab.export.all', (runId?: string) =>
				this.exportAll(runId)
			)
		);
	}

	/**
	 * Export with format picker if not specified.
	 */
	async exportWithPicker(runId?: string, format?: ExportFormat): Promise<void> {
		// Get run ID if not provided
		if (!runId) {
			runId = await this.pickRun();
			if (!runId) {
				return;
			}
		}

		// Get format if not provided
		if (!format) {
			format = await this.pickFormat();
			if (!format) {
				return;
			}
		}

		await this.export(runId, format);
	}

	/**
	 * Export in a specific format.
	 */
	async export(runId: string, format: ExportFormat): Promise<void> {
		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			await vscode.window.showWarningMessage(
				vscode.l10n.t('Backtest run not found.')
			);
			return;
		}

		// Load result data
		const result = await this.loadResult(entry.artifactPath);
		if (!result) {
			await vscode.window.showWarningMessage(
				vscode.l10n.t('Could not load backtest results.')
			);
			return;
		}

		// Get save location
		const defaultName = this.getDefaultFileName(path.basename(entry.strategyPath, path.extname(entry.strategyPath)) || 'backtest', format);
		const fileUri = await vscode.window.showSaveDialog({
			saveLabel: vscode.l10n.t('Export'),
			defaultUri: vscode.Uri.file(defaultName),
			filters: this.getFileFilters(format),
		});

		if (!fileUri) {
			return;
		}

		// Generate content
		const content = this.formatResult(result, format);

		// Write file
		await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));

		await vscode.window.showInformationMessage(
			vscode.l10n.t('Results exported to {0}', path.basename(fileUri.fsPath)),
			vscode.l10n.t('Open')
		).then(selection => {
			if (selection === vscode.l10n.t('Open')) {
				void vscode.commands.executeCommand('vscode.open', fileUri);
			}
		});
	}

	/**
	 * Export all formats to a directory.
	 */
	async exportAll(runId?: string): Promise<void> {
		// Get run ID if not provided
		if (!runId) {
			runId = await this.pickRun();
			if (!runId) {
				return;
			}
		}

		const entry = this.historyState.getEntry(runId);
		if (!entry) {
			await vscode.window.showWarningMessage(
				vscode.l10n.t('Backtest run not found.')
			);
			return;
		}

		// Get output directory
		const folderUri = await vscode.window.showOpenDialog({
			canSelectFolders: true,
			canSelectFiles: false,
			canSelectMany: false,
			openLabel: vscode.l10n.t('Export Here'),
		});

		if (!folderUri || folderUri.length === 0) {
			return;
		}

		const outputDir = folderUri[0];
		const result = await this.loadResult(entry.artifactPath);
		if (!result) {
			await vscode.window.showWarningMessage(
				vscode.l10n.t('Could not load backtest results.')
			);
			return;
		}

		const baseName = path.basename(entry.strategyPath, path.extname(entry.strategyPath)) || 'backtest';
		const formats: ExportFormat[] = ['json', 'csv', 'html'];

		for (const format of formats) {
			const fileName = `${baseName}_${new Date().toISOString().slice(0, 10)}.${format}`;
			const fileUri = vscode.Uri.joinPath(outputDir, fileName);
			const content = this.formatResult(result, format);
			await vscode.workspace.fs.writeFile(fileUri, Buffer.from(content, 'utf8'));
		}

		await vscode.window.showInformationMessage(
			vscode.l10n.t('Exported all formats to {0}', outputDir.fsPath)
		);
	}

	/**
	 * Pick a run from history.
	 */
	private async pickRun(): Promise<string | undefined> {
		const entries = this.historyState.getRecent(20);

		if (entries.length === 0) {
			await vscode.window.showInformationMessage(
				vscode.l10n.t('No backtest runs found.')
			);
			return undefined;
		}

		const items = entries.map(entry => ({
			label: path.basename(entry.strategyPath, path.extname(entry.strategyPath)) || 'Unknown Strategy',
			description: entry.startedAt.toLocaleString(),
			detail: entry.id,
		}));

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t('Select a backtest run to export'),
		});

		return selected?.detail;
	}

	/**
	 * Pick export format.
	 */
	private async pickFormat(): Promise<ExportFormat | undefined> {
		const items: Array<{ label: string; description: string; format: ExportFormat }> = [
			{
				label: 'JSON',
				description: vscode.l10n.t('Full results for programmatic access'),
				format: 'json',
			},
			{
				label: 'CSV',
				description: vscode.l10n.t('Spreadsheet-compatible format'),
				format: 'csv',
			},
			{
				label: 'HTML',
				description: vscode.l10n.t('Visual report for sharing'),
				format: 'html',
			},
		];

		const selected = await vscode.window.showQuickPick(items, {
			placeHolder: vscode.l10n.t('Select export format'),
		});

		return selected?.format;
	}

	/**
	 * Load result from artifact path.
	 */
	private async loadResult(artifactPath: string): Promise<BacktestResult | null> {
		if (!artifactPath) {
			return null;
		}

		try {
			const uri = vscode.Uri.file(artifactPath);
			const resultUri = vscode.Uri.joinPath(uri, 'result.json');
			const data = await vscode.workspace.fs.readFile(resultUri);
			return JSON.parse(Buffer.from(data).toString('utf8')) as BacktestResult;
		} catch {
			return null;
		}
	}

	/**
	 * Format result for export.
	 */
	private formatResult(result: BacktestResult, format: ExportFormat): string {
		switch (format) {
			case 'json':
				return this.formatJson(result);
			case 'csv':
				return this.formatCsv(result);
			case 'html':
				return this.formatHtml(result);
		}
	}

	/**
	 * Format as JSON.
	 */
	private formatJson(result: BacktestResult): string {
		return JSON.stringify({
			metadata: {
				version: '1.0',
				exportedAt: new Date().toISOString(),
				quantlabVersion: '10.0.0',
			},
			...result,
		}, null, 2);
	}

	/**
	 * Format as CSV.
	 */
	private formatCsv(result: BacktestResult): string {
		const lines: string[] = [];

		// Metrics section
		lines.push('# Metrics');
		lines.push('metric,value');
		for (const [key, value] of Object.entries(result.metrics || {})) {
			lines.push(`${key},${this.escapeCSV(value)}`);
		}

		// Trades section
		if (result.trades && result.trades.length > 0) {
			lines.push('');
			lines.push('# Trades');

			// Header
			const columns = Object.keys(result.trades[0]);
			lines.push(columns.join(','));

			// Data rows
			for (const trade of result.trades) {
				const row = columns.map(col => this.escapeCSV(trade[col]));
				lines.push(row.join(','));
			}
		}

		return lines.join('\n');
	}

	/**
	 * Format as HTML.
	 */
	private formatHtml(result: BacktestResult): string {
		const metricsRows = Object.entries(result.metrics || {})
			.map(([key, value]) => `<tr><td>${this.formatKey(key)}</td><td>${value}</td></tr>`)
			.join('');

		let tradesTable = '';
		if (result.trades && result.trades.length > 0) {
			const columns = Object.keys(result.trades[0]);
			const headerRow = columns.map(col => `<th>${this.formatKey(col)}</th>`).join('');
			const dataRows = result.trades.slice(0, 100).map(trade => {
				const cells = columns.map(col => `<td>${trade[col] ?? ''}</td>`).join('');
				return `<tr>${cells}</tr>`;
			}).join('');

			tradesTable = `
				<h2>Trades (${result.trades.length} total)</h2>
				<div style="overflow-x: auto;">
					<table>
						<thead><tr>${headerRow}</tr></thead>
						<tbody>${dataRows}</tbody>
					</table>
				</div>
				${result.trades.length > 100 ? '<p><em>Showing first 100 trades</em></p>' : ''}
			`;
		}

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Quantlab Backtest Report</title>
	<style>
		body {
			font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
			line-height: 1.6;
			max-width: 1200px;
			margin: 0 auto;
			padding: 20px;
			background: #f5f5f5;
		}
		h1 { color: #1a1a2e; }
		h2 { color: #333; border-bottom: 2px solid #ddd; padding-bottom: 8px; }
		table {
			width: 100%;
			border-collapse: collapse;
			background: white;
			box-shadow: 0 1px 3px rgba(0,0,0,0.1);
		}
		th, td {
			padding: 10px 12px;
			text-align: left;
			border-bottom: 1px solid #eee;
		}
		th { background: #f8f9fa; font-weight: 600; }
		tr:hover { background: #f8f9fa; }
		.timestamp { color: #666; font-size: 14px; }
	</style>
</head>
<body>
	<h1>Quantlab Backtest Report</h1>
	<p class="timestamp">Generated: ${new Date().toLocaleString()}</p>

	<h2>Performance Metrics</h2>
	<table>
		<tbody>${metricsRows}</tbody>
	</table>

	${tradesTable}

	<footer style="margin-top: 40px; text-align: center; color: #999;">
		<p>Generated by Quantlab v10.0</p>
	</footer>
</body>
</html>`;
	}

	/**
	 * Escape value for CSV.
	 */
	private escapeCSV(value: unknown): string {
		if (value === null || value === undefined) {
			return '';
		}
		const str = String(value);
		if (str.includes(',') || str.includes('"') || str.includes('\n')) {
			return `"${str.replace(/"/g, '""')}"`;
		}
		return str;
	}

	/**
	 * Format key for display.
	 */
	private formatKey(key: string): string {
		return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
	}

	/**
	 * Get default file name.
	 */
	private getDefaultFileName(strategyName: string, format: ExportFormat): string {
		const date = new Date().toISOString().slice(0, 10);
		const safeName = strategyName.replace(/[^a-zA-Z0-9]/g, '_');
		return `${safeName}_${date}.${format}`;
	}

	/**
	 * Get file filters for save dialog.
	 */
	private getFileFilters(format: ExportFormat): Record<string, string[]> {
		switch (format) {
			case 'json':
				return { 'JSON Files': ['json'] };
			case 'csv':
				return { 'CSV Files': ['csv'] };
			case 'html':
				return { 'HTML Files': ['html'] };
		}
	}
}

/**
 * Register export commands.
 */
export function registerExportCommands(
	context: vscode.ExtensionContext,
	historyState: HistoryState
): void {
	const commands = ExportCommands.initialize(historyState, context.extensionPath);
	commands.registerCommands(context);
}
