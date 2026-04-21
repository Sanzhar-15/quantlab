# Prompt 11: Stats Engine Interface

## Objective
Create the TypeScript interface for executing statistical tests via Python.

## Context
The existing EngineHost runs Python strategies. We need a parallel interface for running stats tests that doesn't require strategy files.

## File to Create

### `extensions/quantlab/src/stats/StatsEngine.ts`

```typescript
/*---------------------------------------------------------------------------------------------
 *  Stats Engine - Executes statistical tests via Python
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import { spawn, ChildProcess } from 'child_process';
import { StatsTestConfig, StatsTestResult } from '../types/stats';
import { StatsJobRequest, StatsJobResult } from '../types/engine';

interface StatsProgress {
    progress: number;
    message: string;
}

type ProgressCallback = (progress: StatsProgress) => void;

export class StatsEngine {
    private static instance: StatsEngine;
    private pythonPath: string;
    private scriptsPath: string;
    private activeProcess: ChildProcess | null = null;

    private constructor(private readonly context: vscode.ExtensionContext) {
        this.pythonPath = 'python3'; // TODO: Get from settings
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

            this.activeProcess = spawn(this.pythonPath, args, {
                cwd: this.scriptsPath,
                env: {
                    ...process.env,
                    PYTHONUNBUFFERED: '1'
                }
            });

            let stdout = '';
            let stderr = '';

            this.activeProcess.stdout?.on('data', (data: Buffer) => {
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

            this.activeProcess.stderr?.on('data', (data: Buffer) => {
                stderr += data.toString();
            });

            this.activeProcess.on('close', (code) => {
                this.activeProcess = null;

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

            this.activeProcess.on('error', (err) => {
                this.activeProcess = null;
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
}
```

## Command Registration

### Add to `extensions/quantlab/src/commands/dataCommands.ts`

```typescript
import { StatsEngine } from '../stats/StatsEngine';
import { StatsTestConfig, StatsTestResult } from '../types/stats';

// Add in registerDataCommands function:

// Execute stats test (called by StatsViewProvider)
// Accepts optional progress callback as second argument
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
        const engine = StatsEngine.getInstance();
        engine.cancel();
    })
);
```

## Test

1. TypeScript compiles:
   ```bash
   cd extensions/quantlab && npx tsc --noEmit
   ```

2. Engine instantiates:
   ```typescript
   const engine = StatsEngine.getInstance(context);
   // Should not throw
   ```

3. Python runner exists (created in Prompt 12):
   ```bash
   ls extensions/quantlab/python/stats/runner.py
   ```

## Dependencies
- Prompt 01 (types) for StatsTestConfig, StatsTestResult, StatsJobRequest

## Next
Proceed to `12_Python_Stats_Runner.md`
