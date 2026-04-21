/*---------------------------------------------------------------------------------------------
 *  Data file commands for QuantLab
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn } from 'child_process';
import { DataViewManager } from '../views/DataViewManager';
import { ResourcesWebviewProvider } from '../panels/resources/ResourcesWebviewProvider';
import { StatsEngine } from '../stats/StatsEngine';
import { ToolExecutionService } from '../core/server/ToolExecutionService';
import { StatsTestConfig, StatsTestResult } from '../types/stats';
import { ColumnInfo } from '../types/data';

// Cache for data file inspection results
const inspectionCache = new Map<string, { columns: ColumnInfo[]; preview: { rows: number; sample: Record<string, unknown>[] }; dateRange?: { start: string; end: string }; timestamp: number }>();
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Get Python executable path with platform-aware fallback
 */
function getPythonPath(): string {
    // Check VS Code Python extension setting first
    const pythonConfig = vscode.workspace.getConfiguration('python');
    const configuredPath = pythonConfig.get<string>('defaultInterpreterPath');
    if (configuredPath) {
        return configuredPath;
    }

    // Platform-specific fallback
    return process.platform === 'win32' ? 'python' : 'python3';
}

export function registerDataCommands(context: vscode.ExtensionContext): void {
    const manager = DataViewManager.getInstance();

    // Switch to Visualise view
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.switchToVisualise', async () => {
            try {
                const resource = getActiveDataResource();
                if (resource) {
                    await manager.switchToVisualise(resource);
                }
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Failed to switch to Visualise view: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    // Open Data Action (focuses Resources panel with Pure Stats)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.openDataAction', async () => {
            try {
                const resource = getActiveDataResource();
                if (resource) {
                    await manager.openDataAction(resource);
                }
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Failed to open data action: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    // Switch to Editor view for data files
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.switchToDataEditor', async () => {
            try {
                const resource = getActiveDataResource();
                if (resource) {
                    await manager.switchToEditor(resource);
                }
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Failed to switch to Editor view: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    // Open specific stats test (called from Resources panel)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.openStatsTest', async (testId: string) => {
            try {
                await manager.openStatsTest(testId);
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Failed to open stats test: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    // Set Resources panel section (called by DataViewManager and external code)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.setResourcesSection', (section: 'strategy' | 'stats') => {
            const provider = ResourcesWebviewProvider.getInstance();
            provider.setSection(section);
        })
    );

    // Alias for backwards compatibility
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.resources.setSection', (section: 'strategy' | 'stats') => {
            const provider = ResourcesWebviewProvider.getInstance();
            provider.setSection(section);
        })
    );

    // Execute stats test (called by StatsViewProvider)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.executeStatsTest',
            async (
                config: StatsTestConfig,
                progressCallback?: (progress: number, message: string) => void
            ): Promise<StatsTestResult | null> => {
                const engine = StatsEngine.getInstance(context);

                try {
                    const result = await engine.executeTest(config, (progress) => {
                        // Forward progress to caller if callback provided
                        if (progressCallback) {
                            progressCallback(progress.progress, progress.message);
                        }
                    });
                    return result;
                } catch (err) {
                    void vscode.window.showErrorMessage(
                        `Stats test failed: ${err instanceof Error ? err.message : String(err)}`
                    );
                    return null;
                }
            }
        )
    );

    // Cancel running stats test
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.cancelStatsTest', () => {
            // Pass context to ensure singleton is initialized safely
            const engine = StatsEngine.getInstance(context);
            engine.cancel();
        })
    );

    // Cancel server tool execution by job ID
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.cancelToolExecution', async (jobId: string) => {
            try {
                await ToolExecutionService.getInstance().cancelExecution(jobId);
            } catch (err) {
                void vscode.window.showErrorMessage(
                    `Failed to cancel execution: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        })
    );

    // Get data file columns (used by StatsViewProvider and VisualiseViewProvider)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.getDataFileColumns',
            async (filePath: string): Promise<ColumnInfo[]> => {
                const result = await inspectDataFile(context, filePath);
                return result?.columns ?? [];
            }
        )
    );

    // Get data file preview (used by VisualiseViewProvider)
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.getDataFilePreview',
            async (filePath: string, sampleSize?: number): Promise<{ rows: number; sample: Record<string, unknown>[] } | null> => {
                const result = await inspectDataFile(context, filePath, sampleSize);
                return result?.preview ?? null;
            }
        )
    );
}

/**
 * Inspect a data file using the Python script
 */
async function inspectDataFile(
    context: vscode.ExtensionContext,
    filePath: string,
    sampleSize: number = 100
): Promise<{ columns: ColumnInfo[]; preview: { rows: number; sample: Record<string, unknown>[] }; dateRange?: { start: string; end: string } } | null> {
    // Check cache
    const cacheKey = `${filePath}:${sampleSize}`;
    const cached = inspectionCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return { columns: cached.columns, preview: cached.preview, dateRange: cached.dateRange };
    }

    const pythonPath = getPythonPath();
    const scriptPath = path.join(context.extensionPath, 'python', 'data', 'inspect_data.py');

    return new Promise((resolve) => {
        const args = [
            scriptPath,
            filePath,
            '--action', 'all',
            '--sample-size', String(sampleSize)
        ];

        const proc = spawn(pythonPath, args, {
            env: { ...process.env, PYTHONUNBUFFERED: '1' }
        });

        let stdout = '';
        let stderr = '';

        proc.stdout?.on('data', (data: Buffer) => {
            stdout += data.toString();
        });

        proc.stderr?.on('data', (data: Buffer) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            if (code !== 0) {
                console.error(`Data inspection failed: ${stderr}`);
                resolve(null);
                return;
            }

            try {
                const result = JSON.parse(stdout);
                const columns = (result.columns ?? []) as ColumnInfo[];
                const preview = result.preview ?? { rows: 0, sample: [] };
                const dateRange = result.dateRange ? {
                    start: result.dateRange.start,
                    end: result.dateRange.end
                } : undefined;

                // Cache result
                inspectionCache.set(cacheKey, {
                    columns,
                    preview,
                    dateRange,
                    timestamp: Date.now()
                });

                resolve({ columns, preview, dateRange });
            } catch (err) {
                console.error(`Failed to parse inspection result: ${err}`);
                resolve(null);
            }
        });

        proc.on('error', (err) => {
            console.error(`Failed to spawn Python process: ${err.message}`);
            resolve(null);
        });
    });
}

/**
 * Get the active data file resource from the current editor
 */
function getActiveDataResource(): vscode.Uri | undefined {
    const manager = DataViewManager.getInstance();

    // First check if there's a tracked active data file
    const tracked = manager.getActiveDataFile();
    if (tracked) {
        return tracked;
    }

    // Fall back to checking the active tab
    const activeTab = vscode.window.tabGroups.activeTabGroup?.activeTab;
    if (!activeTab) {
        void vscode.window.showWarningMessage('No data file is open.');
        return undefined;
    }

    let uri: vscode.Uri | undefined;

    if (activeTab.input instanceof vscode.TabInputText) {
        uri = activeTab.input.uri;
    } else if (activeTab.input instanceof vscode.TabInputCustom) {
        uri = activeTab.input.uri;
    }

    if (!uri) {
        void vscode.window.showWarningMessage('Cannot determine file from current editor.');
        return undefined;
    }

    if (!manager.isDataFile(uri)) {
        void vscode.window.showWarningMessage('Current file is not a supported data file.');
        return undefined;
    }

    return uri;
}
