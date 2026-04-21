/*---------------------------------------------------------------------------------------------
 *  Stats Engine - Executes statistical tests via Python
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { StatsTestConfig, StatsTestResult } from '../types/stats';
import { StatsJobRequest } from '../types/engine';

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

interface StatsProgress {
    progress: number;
    message: string;
}

type ProgressCallback = (progress: StatsProgress) => void;

export class StatsEngine {
    private static instance: StatsEngine | undefined;
    private pythonPath: string;
    private scriptsPath: string;
    private activeProcess: ChildProcess | null = null;

    private constructor(context: vscode.ExtensionContext) {
        this.pythonPath = getPythonPath();
        this.scriptsPath = path.join(context.extensionPath, 'python', 'stats');
    }

    static getInstance(context?: vscode.ExtensionContext): StatsEngine {
        if (!StatsEngine.instance) {
            if (!context) {
                throw new Error('StatsEngine must be initialized with context');
            }
            StatsEngine.instance = new StatsEngine(context);
        }
        return StatsEngine.instance;
    }

    /**
     * Execute a statistical test
     */
    async executeTest(
        config: StatsTestConfig,
        onProgress?: ProgressCallback
    ): Promise<StatsTestResult> {
        const jobId = this.generateJobId();

        const jobRequest: StatsJobRequest = {
            jobId,
            action: 'stats',
            testId: config.testId,
            dataPath: config.dataPath,
            columns: config.columns,
            parameters: config.parameters,
            createdAt: new Date().toISOString()
        };

        return new Promise((resolve, reject) => {
            const args = [
                path.join(this.scriptsPath, 'runner.py'),
                '--job', JSON.stringify(jobRequest)
            ];

            const proc = spawn(this.pythonPath, args, {
                cwd: this.scriptsPath,
                env: {
                    ...process.env,
                    PYTHONUNBUFFERED: '1'
                }
            });
            this.activeProcess = proc;

            let stdout = '';
            let stderr = '';

            proc.stdout?.on('data', (data: Buffer) => {
                const text = data.toString();
                stdout += text;

                // Parse progress updates (JSON lines)
                const lines = text.split('\n').filter(l => l.trim());
                for (const line of lines) {
                    try {
                        const msg = JSON.parse(line);
                        if (msg.type === 'progress' && onProgress) {
                            onProgress({
                                progress: msg.progress,
                                message: msg.message
                            });
                        }
                    } catch {
                        // Not JSON, ignore
                    }
                }
            });

            proc.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            proc.on('close', (code) => {
                if (this.activeProcess === proc) { this.activeProcess = null; }

                if (code !== 0) {
                    reject(new Error(`Stats test failed: ${stderr || 'Unknown error'}`));
                    return;
                }

                // Parse final result from stdout
                try {
                    const result = this.parseResult(stdout);
                    resolve(result);
                } catch (err) {
                    reject(err);
                }
            });

            proc.on('error', (err) => {
                if (this.activeProcess === proc) { this.activeProcess = null; }
                reject(new Error(`Failed to spawn Python process: ${err.message}`));
            });
        });
    }

    /**
     * Cancel running test
     */
    cancel(): void {
        if (this.activeProcess) {
            this.activeProcess.kill('SIGTERM');
            this.activeProcess = null;
        }
    }

    private parseResult(stdout: string): StatsTestResult {
        // Find the result JSON (last valid JSON object with type: 'result')
        const lines = stdout.split('\n').filter(l => l.trim());

        for (let i = lines.length - 1; i >= 0; i--) {
            try {
                const parsed = JSON.parse(lines[i]);
                if (parsed.type === 'result') {
                    return {
                        testId: parsed.testId,
                        testName: parsed.testName,
                        statistic: parsed.statistic,
                        pValue: parsed.pValue,
                        criticalValues: parsed.criticalValues,
                        conclusion: parsed.conclusion,
                        interpretation: parsed.interpretation,
                        details: parsed.details || {},
                        visualizations: parsed.visualizations
                    };
                }
            } catch {
                continue;
            }
        }

        throw new Error('No valid result found in Python output');
    }

    private generateJobId(): string {
        return `stats-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    dispose(): void {
        this.cancel();
    }

    static resetInstance(): void {
        if (StatsEngine.instance) {
            StatsEngine.instance.dispose();
            StatsEngine.instance = undefined;
        }
    }
}
