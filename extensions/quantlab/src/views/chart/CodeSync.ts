/**
 * Code Synchronization for Time-Travel Debugger.
 *
 * Provides bi-directional synchronization between:
 * - Chart view (current bar position)
 * - Code editor (highlighted line)
 *
 * Features:
 * - Highlight code lines when stepping through bars
 * - Jump to bar when clicking code markers
 * - Show decision point decorations
 *
 * Spec Reference: Product Spec Section 4.2, Technical Spec Section 19
 */

import * as vscode from 'vscode';
import * as path from 'path';

/** Condition capture from debug file */
export interface ConditionCapture {
    barIndex: number;
    lineNumber: number;
    expression: string;
    leftValue: string;
    operator: string;
    rightValue: string;
    result: boolean;
}

/**
 * Code Synchronization Manager.
 *
 * Manages the link between chart debugger state and code editor.
 */
export class CodeSyncManager implements vscode.Disposable {
    private disposables: vscode.Disposable[] = [];
    private strategyUri: vscode.Uri | null = null;
    private editor: vscode.TextEditor | null = null;

    // Decoration types
    private trueDecorationType: vscode.TextEditorDecorationType;
    private falseDecorationType: vscode.TextEditorDecorationType;
    private highlightDecorationType: vscode.TextEditorDecorationType;

    // Current state
    private currentBarIndex: number = 0;
    private conditions: Map<number, ConditionCapture[]> = new Map();

    constructor() {
        // Create decoration types
        this.trueDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 0, 0.1)',
            after: {
                contentText: ' → TRUE',
                color: 'rgba(0, 200, 0, 0.8)',
                fontStyle: 'italic',
                margin: '0 0 0 1em',
            },
            isWholeLine: true,
        });

        this.falseDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.1)',
            after: {
                contentText: ' → FALSE',
                color: 'rgba(200, 0, 0, 0.8)',
                fontStyle: 'italic',
                margin: '0 0 0 1em',
            },
            isWholeLine: true,
        });

        this.highlightDecorationType = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 255, 0, 0.2)',
            border: '1px solid rgba(255, 255, 0, 0.5)',
            isWholeLine: true,
        });

        // Listen for editor changes
        this.disposables.push(
            vscode.window.onDidChangeActiveTextEditor((editor) => {
                if (editor && this.isStrategyFile(editor.document.uri)) {
                    this.editor = editor;
                    this.updateDecorations();
                }
            })
        );
    }

    /**
     * Set the strategy file to synchronize with.
     */
    setStrategyFile(strategyPath: string): void {
        this.strategyUri = vscode.Uri.file(strategyPath);

        // Try to find or open the editor
        const existingEditor = vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.fsPath === this.strategyUri?.fsPath
        );

        if (existingEditor) {
            this.editor = existingEditor;
        }
    }

    /**
     * Load conditions from debug file data.
     */
    loadConditions(conditions: ConditionCapture[]): void {
        this.conditions.clear();

        for (const condition of conditions) {
            const barConditions = this.conditions.get(condition.barIndex) || [];
            barConditions.push(condition);
            this.conditions.set(condition.barIndex, barConditions);
        }
    }

    /**
     * Update to show conditions at a specific bar.
     */
    setBarIndex(barIndex: number): void {
        this.currentBarIndex = barIndex;
        this.updateDecorations();
    }

    /**
     * Highlight a specific line in the code editor.
     */
    async highlightLine(lineNumber: number): Promise<void> {
        if (!this.strategyUri) {
            return;
        }

        // Open the document if not visible
        const document = await vscode.workspace.openTextDocument(this.strategyUri);
        this.editor = await vscode.window.showTextDocument(document, {
            preserveFocus: true,
            preview: false,
        });

        // Scroll to and highlight the line
        const line = Math.max(0, lineNumber - 1); // Convert to 0-based
        const range = new vscode.Range(line, 0, line, 0);

        this.editor.revealRange(range, vscode.TextEditorRevealType.InCenter);

        // Apply highlight decoration
        this.editor.setDecorations(this.highlightDecorationType, [
            { range: document.lineAt(line).range },
        ]);

        // Remove highlight after a short delay
        setTimeout(() => {
            if (this.editor) {
                this.editor.setDecorations(this.highlightDecorationType, []);
            }
        }, 2000);
    }

    /**
     * Update code decorations based on current bar's conditions.
     */
    private updateDecorations(): void {
        if (!this.editor || !this.isStrategyFile(this.editor.document.uri)) {
            return;
        }

        const barConditions = this.conditions.get(this.currentBarIndex) || [];

        const trueDecorations: vscode.DecorationOptions[] = [];
        const falseDecorations: vscode.DecorationOptions[] = [];

        for (const condition of barConditions) {
            const line = Math.max(0, condition.lineNumber - 1);

            if (line >= this.editor.document.lineCount) {
                continue;
            }

            const lineRange = this.editor.document.lineAt(line).range;
            const hoverMessage = new vscode.MarkdownString();
            hoverMessage.appendMarkdown(`**Condition:** \`${condition.expression}\`\n\n`);
            hoverMessage.appendMarkdown(
                `**Values:** \`${condition.leftValue}\` ${condition.operator} \`${condition.rightValue}\`\n\n`
            );
            hoverMessage.appendMarkdown(`**Result:** ${condition.result ? '✅ TRUE' : '❌ FALSE'}`);

            const decoration: vscode.DecorationOptions = {
                range: lineRange,
                hoverMessage,
            };

            if (condition.result) {
                trueDecorations.push(decoration);
            } else {
                falseDecorations.push(decoration);
            }
        }

        this.editor.setDecorations(this.trueDecorationType, trueDecorations);
        this.editor.setDecorations(this.falseDecorationType, falseDecorations);
    }

    /**
     * Clear all decorations.
     */
    clearDecorations(): void {
        if (this.editor) {
            this.editor.setDecorations(this.trueDecorationType, []);
            this.editor.setDecorations(this.falseDecorationType, []);
            this.editor.setDecorations(this.highlightDecorationType, []);
        }
    }

    /**
     * Check if a URI is the current strategy file.
     */
    private isStrategyFile(uri: vscode.Uri): boolean {
        return this.strategyUri !== null && uri.fsPath === this.strategyUri.fsPath;
    }

    /**
     * Get all bar indices that have conditions on a specific line.
     */
    getBarsForLine(lineNumber: number): number[] {
        const bars: number[] = [];

        for (const [barIndex, conditions] of this.conditions) {
            if (conditions.some((c) => c.lineNumber === lineNumber)) {
                bars.push(barIndex);
            }
        }

        return bars.sort((a, b) => a - b);
    }

    /**
     * Dispose resources.
     */
    dispose(): void {
        this.clearDecorations();
        this.trueDecorationType.dispose();
        this.falseDecorationType.dispose();
        this.highlightDecorationType.dispose();
        this.disposables.forEach((d) => d.dispose());
    }
}

/**
 * Create gutter icons for bars with trades.
 */
export function createTradeGutterDecorations(
    editor: vscode.TextEditor,
    tradeLines: number[]
): vscode.TextEditorDecorationType {
    const decorationType = vscode.window.createTextEditorDecorationType({
        gutterIconPath: path.join(__dirname, '..', '..', '..', 'media', 'trade-marker.svg'),
        gutterIconSize: 'contain',
    });

    const decorations: vscode.DecorationOptions[] = tradeLines.map((line) => ({
        range: new vscode.Range(line - 1, 0, line - 1, 0),
    }));

    editor.setDecorations(decorationType, decorations);

    return decorationType;
}
