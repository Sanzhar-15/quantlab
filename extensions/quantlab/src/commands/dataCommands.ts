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
import { resolveDatasetPath } from '../qviz/persist';
import { resolveQuantlabPython } from '../qviz/pythonPath';

// Cache for data file inspection results
const inspectionCache = new Map<string, { columns: ColumnInfo[]; preview: { rows: number; sample: Record<string, unknown>[] }; dateRange?: { start: string; end: string }; timestamp: number }>();
const CACHE_TTL_MS = 60000; // 1 minute

/**
 * Resolve the Python interpreter for the data-inspector subprocess.
 *
 * Smoke-test fix (2026-05-11): the prior implementation only consulted
 * `python.defaultInterpreterPath` and otherwise fell back to bare `python3`
 * on PATH -- which on stock macOS is `/usr/bin/python3` (the
 * CommandLineTools Python 3.9 with NO pandas/pyarrow). The inspector
 * script crashes on first `import pandas`, the data commands throw
 * DataInspectionError, and VisualiseDataProvider renders its empty state
 * showing "No data available for visualisation". The user sees nothing
 * actionable.
 *
 * Now uses the SAME resolver as the qviz daemon
 * (`src/qviz/pythonPath.ts`), which consults in order:
 *   1. `QUANTLAB_PYTHON` env var
 *   2. `quantlab.pythonPath` setting
 *   3. `python.defaultInterpreterPath` setting
 *   4. `~/.quantlab/venv/bin/python` (managed venv)
 *
 * Throws a typed error when none resolve -- the caller surfaces it
 * via the existing DataInspectionError -> showErrorMessage chain so
 * the user gets an actionable notification instead of a silent empty
 * panel.
 */
function getPythonPath(): string {
    const quantlabConfig = vscode.workspace.getConfiguration('quantlab');
    const pythonExtConfig = vscode.workspace.getConfiguration('python');
    const resolved = resolveQuantlabPython({
        quantlabConfigPath: quantlabConfig.get<string>('pythonPath'),
        pythonExtConfigPath: pythonExtConfig.get<string>('defaultInterpreterPath'),
    });
    if (resolved !== null) {
        return resolved.pythonPath;
    }
    // No Python found -- throw so the caller's catch in
    // VisualiseDataProvider surfaces it via showErrorMessage.
    // Per CLAUDE.md "errors must be visible": do NOT fall back to bare
    // `python3` (the previous silent fallback that caused this bug).
    throw new Error(
        'Quantlab: no Python interpreter found for the data inspector. '
        + 'Set `quantlab.pythonPath` to a Python >= 3.10 with pandas+pyarrow installed, '
        + 'or create the managed venv at ~/.quantlab/venv.',
    );
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

    // Get data file columns (used by StatsViewProvider and VisualiseDataProvider).
    //
    // Throws (rejects) on inspection failure -- the previous "?? []" fallback
    // silently masked Python errors as "no columns" and led to confused UIs
    // that rendered empty pickers without indication of failure (audit-fix
    // C3+M1). Callers MUST handle the rejection and surface the error to the
    // user.
    //
    // Megaudit CRITICAL-13: validate `filePath` against the workspace
    // boundary BEFORE spawning Python. Previously the command accepted
    // any string — including absolute paths, ../escape, /etc/passwd —
    // and the Python script `inspect_data.py` happily read whatever
    // path it was handed and returned the contents. ActionViewProvider
    // forwards webview-supplied paths into this command, opening a
    // file-read RCE-adjacent vector.
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.getDataFileColumns',
            async (filePath: string): Promise<ColumnInfo[]> => {
                assertSafeDataFilePath(filePath);
                const result = await inspectDataFile(context, filePath);
                return result.columns;
            }
        )
    );

    // Get data file preview (used by VisualiseDataProvider).
    // Throws on inspection failure; see above.
    context.subscriptions.push(
        vscode.commands.registerCommand('quantlab.getDataFilePreview',
            async (filePath: string, sampleSize?: number): Promise<{ rows: number; sample: Record<string, unknown>[] }> => {
                assertSafeDataFilePath(filePath);
                const result = await inspectDataFile(context, filePath, sampleSize);
                return result.preview;
            }
        )
    );
}

/**
 * Megaudit CRITICAL-13: gate the Python data-inspector spawn behind
 * the same workspace-boundary + extension-allowlist checks the qviz
 * daemon path uses. Refuses paths outside the workspace, `..` escapes,
 * and extensions outside parquet/csv/tsv. The caller (often a webview
 * message OR VS Code's URI machinery) cannot smuggle `/etc/passwd` or
 * `~/.aws/credentials` through.
 *
 * Smoke-test fix (2026-05-11): the prior implementation rejected ALL
 * absolute paths because the qviz `resolveDatasetPath` validator
 * expects workspace-relative URIs (.qviz.json's `dataset.uri` field is
 * always relative). But VS Code's `uri.fsPath` is ALWAYS absolute, so
 * the legitimate "Visualise a data file" path (DataViewManager
 * forwarding `vscode.Uri.fsPath` to `quantlab.getDataFileColumns`)
 * was rejected too. Now we accept an absolute path iff it strictly
 * lives inside one of the open workspace folders, then re-derive the
 * workspace-relative form before handing it to `resolveDatasetPath`
 * for the rest of the checks (extension allowlist, symlink-escape,
 * file-exists). Strict containment via `path.relative` ruling out
 * `..` and absolute outputs blocks the original /etc/passwd attack.
 */
// Megaudit-2 A4-M7: exported for unit tests in
// `test/qviz-assert-safe-data-file-path.test.ts`. Production callers
// still go through the two existing invocations above; the export
// just lets tests reach the function without spawning the inspector.
export function assertSafeDataFilePath(filePath: unknown): void {
    if (typeof filePath !== 'string' || filePath.length === 0) {
        throw new Error('quantlab data command: filePath must be a non-empty string');
    }
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
        throw new Error('quantlab data command: no workspace folder open');
    }
    // If the caller handed us an absolute path (the VS Code URI case),
    // try to demote it to workspace-relative against each open folder.
    // `path.relative(root, abs)` returns "" or "subdir/file" when abs is
    // inside root, "../..." when it escapes, or an absolute path when
    // the two are on different roots (Windows drive letters). Both
    // escape-rels and absolute returns are unsafe -- reject.
    const candidates: { folder: vscode.WorkspaceFolder; relPath: string }[] = [];
    if (path.isAbsolute(filePath)) {
        for (const f of folders) {
            const rel = path.relative(f.uri.fsPath, filePath);
            if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
                continue; // not inside this folder
            }
            candidates.push({ folder: f, relPath: rel });
        }
        if (candidates.length === 0) {
            throw new Error(
                `quantlab data command: filePath '${filePath}' refused — `
                + 'absolute path is not inside any open workspace folder',
            );
        }
    } else {
        // Relative path: every folder is a candidate; resolveDatasetPath
        // will reject the ones where the file doesn't actually exist.
        for (const f of folders) {
            candidates.push({ folder: f, relPath: filePath });
        }
    }
    // For each candidate, run the qviz resolver (extension allowlist +
    // symlink-escape + file-exists). The first OK wins.
    for (const { folder, relPath } of candidates) {
        const result = resolveDatasetPath(relPath, folder.uri.fsPath);
        if (result.kind === 'ok') { return; }
    }
    throw new Error(
        `quantlab data command: filePath '${filePath}' refused — `
        + 'must point at an existing parquet/csv/tsv inside an open workspace folder '
        + '(no ".." escapes, no symlinks pointing outside the workspace)',
    );
}

/** Typed error for data inspection failures so callers can pattern-match
 *  on the failure mode (spawn / nonzero-exit / parse) when surfacing the
 *  problem to the user. */
export class DataInspectionError extends Error {
    constructor(
        readonly kind: 'spawn' | 'exit' | 'parse',
        readonly filePath: string,
        readonly detail: string,
        readonly exitCode?: number,
        readonly stderr?: string,
    ) {
        super(`Data inspection ${kind} failure for ${filePath}: ${detail}`);
        this.name = 'DataInspectionError';
    }
}

/**
 * Inspect a data file using the Python script.
 *
 * Throws DataInspectionError on every failure mode (audit-fix C3+M1: prior
 * implementation resolved with `null` and let callers fall back to empty
 * arrays/null, hiding Python crashes / missing interpreter / corrupt
 * parquet behind blank UIs).
 */
async function inspectDataFile(
    context: vscode.ExtensionContext,
    filePath: string,
    sampleSize: number = 100
): Promise<{ columns: ColumnInfo[]; preview: { rows: number; sample: Record<string, unknown>[] }; dateRange?: { start: string; end: string } }> {
    // Check cache
    const cacheKey = `${filePath}:${sampleSize}`;
    const cached = inspectionCache.get(cacheKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return { columns: cached.columns, preview: cached.preview, dateRange: cached.dateRange };
    }

    const pythonPath = getPythonPath();
    const scriptPath = path.join(context.extensionPath, 'python', 'data', 'inspect_data.py');

    return new Promise((resolve, reject) => {
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
                console.error(`Data inspection failed (exit=${code}): ${stderr}`);
                reject(new DataInspectionError(
                    'exit', filePath,
                    `python exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`,
                    code ?? undefined, stderr,
                ));
                return;
            }

            let result: { columns?: ColumnInfo[]; preview?: { rows: number; sample: Record<string, unknown>[] }; dateRange?: { start: string; end: string } };
            try {
                result = JSON.parse(stdout);
            } catch (err) {
                const detail = `${(err as Error).message ?? err} -- stdout head: ${stdout.slice(0, 200)}`;
                console.error(`Failed to parse inspection result: ${detail}`);
                reject(new DataInspectionError('parse', filePath, detail));
                return;
            }

            const columns = (result.columns ?? []) as ColumnInfo[];
            const preview = result.preview ?? { rows: 0, sample: [] };
            const dateRange = result.dateRange ? {
                start: result.dateRange.start,
                end: result.dateRange.end
            } : undefined;

            inspectionCache.set(cacheKey, {
                columns, preview, dateRange,
                timestamp: Date.now(),
            });
            resolve({ columns, preview, dateRange });
        });

        proc.on('error', (err) => {
            console.error(`Failed to spawn Python process: ${err.message}`);
            reject(new DataInspectionError('spawn', filePath, err.message));
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
