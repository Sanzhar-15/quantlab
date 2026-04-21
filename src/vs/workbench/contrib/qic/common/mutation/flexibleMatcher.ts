/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { EditOperation, Range } from '../canonical/types.js';

export interface MatchResult {
	strategy: number;
	strategyName: string;
	originalRange: Range;
	matchedRange: Range;
	confidence: number;
}

/**
 * 7 graduated strategies for matching edit locations in files
 * that have been modified since the EditScript was generated.
 *
 * Performance target (Audit II-PG5): P50 < 20ms per matching operation.
 */
export class FlexibleMatcher {

	findMatch(
		editOp: EditOperation,
		originalContent: string,
		currentContent: string,
	): MatchResult | null {
		const range = this.getRange(editOp);
		if (!range) { return null; }

		const originalLines = originalContent.split('\n');
		const currentLines = currentContent.split('\n');
		const targetLines = originalLines.slice(range.startLine - 1, range.endLine);
		const targetText = targetLines.join('\n');

		// Strategy 1: Exact Match
		const exact = this.tryExactMatch(targetText, currentLines, range);
		if (exact) { return { ...exact, strategy: 1, strategyName: 'exact' }; }

		// Strategy 2: Line-Shifted Match
		const shifted = this.tryLineShiftedMatch(targetText, currentLines, range);
		if (shifted) { return { ...shifted, strategy: 2, strategyName: 'line-shifted' }; }

		// Strategy 3: Fuzzy Line Match (Levenshtein > 0.8 similarity)
		const fuzzy = this.tryFuzzyLineMatch(targetText, currentLines, range);
		if (fuzzy) { return { ...fuzzy, strategy: 3, strategyName: 'fuzzy-line' }; }

		// Strategy 4: AST-Aware Match (stub — requires tree-sitter)
		const ast = this.tryAstAwareMatch(targetText, currentContent, range);
		if (ast) { return { ...ast, strategy: 4, strategyName: 'ast-aware' }; }

		// Strategy 5: Fuzzy Edit Distance (editDistance/lineCount < 0.3)
		const editDist = this.tryFuzzyEditDistance(targetText, currentLines, range);
		if (editDist) { return { ...editDist, strategy: 5, strategyName: 'fuzzy-edit-distance' }; }

		// Strategy 6: Semantic Context Match (enclosing scope)
		const semantic = this.trySemanticContextMatch(targetLines, originalLines, currentLines, range);
		if (semantic) { return { ...semantic, strategy: 6, strategyName: 'semantic-context' }; }

		// Strategy 7: LLM Instruction-Based (stub — wired in Prompt 10)
		// Not invoked here; the caller should fall back to LLM if all 6 strategies fail.

		return null;
	}

	private getRange(editOp: EditOperation): Range | null {
		if (editOp.type === 'replace' || editOp.type === 'delete') {
			return editOp.range;
		}
		if (editOp.type === 'insert') {
			return {
				startLine: editOp.position.line,
				startColumn: editOp.position.column,
				endLine: editOp.position.line,
				endColumn: editOp.position.column,
			};
		}
		return null;
	}

	private tryExactMatch(
		targetText: string,
		currentLines: string[],
		originalRange: Range,
	): Omit<MatchResult, 'strategy' | 'strategyName'> | null {
		const startIdx = originalRange.startLine - 1;
		const lineCount = originalRange.endLine - originalRange.startLine + 1;

		if (startIdx + lineCount > currentLines.length) { return null; }

		const currentSlice = currentLines.slice(startIdx, startIdx + lineCount).join('\n');
		if (currentSlice === targetText) {
			return {
				originalRange,
				matchedRange: originalRange,
				confidence: 1.0,
			};
		}
		return null;
	}

	private tryLineShiftedMatch(
		targetText: string,
		currentLines: string[],
		originalRange: Range,
	): Omit<MatchResult, 'strategy' | 'strategyName'> | null {
		const lineCount = originalRange.endLine - originalRange.startLine + 1;
		const searchRadius = Math.min(50, currentLines.length);

		for (let offset = -searchRadius; offset <= searchRadius; offset++) {
			if (offset === 0) { continue; }
			const startIdx = originalRange.startLine - 1 + offset;
			if (startIdx < 0 || startIdx + lineCount > currentLines.length) { continue; }

			const currentSlice = currentLines.slice(startIdx, startIdx + lineCount).join('\n');
			if (currentSlice === targetText) {
				return {
					originalRange,
					matchedRange: {
						startLine: startIdx + 1,
						startColumn: originalRange.startColumn,
						endLine: startIdx + lineCount,
						endColumn: originalRange.endColumn,
					},
					confidence: 0.95,
				};
			}
		}
		return null;
	}

	private tryFuzzyLineMatch(
		targetText: string,
		currentLines: string[],
		originalRange: Range,
	): Omit<MatchResult, 'strategy' | 'strategyName'> | null {
		const lineCount = originalRange.endLine - originalRange.startLine + 1;
		let bestSimilarity = 0;
		let bestStartIdx = -1;

		for (let startIdx = 0; startIdx + lineCount <= currentLines.length; startIdx++) {
			const currentSlice = currentLines.slice(startIdx, startIdx + lineCount).join('\n');
			const similarity = this.computeSimilarity(targetText, currentSlice);

			if (similarity > bestSimilarity) {
				bestSimilarity = similarity;
				bestStartIdx = startIdx;
			}
		}

		if (bestSimilarity > 0.8 && bestStartIdx >= 0) {
			return {
				originalRange,
				matchedRange: {
					startLine: bestStartIdx + 1,
					startColumn: originalRange.startColumn,
					endLine: bestStartIdx + lineCount,
					endColumn: originalRange.endColumn,
				},
				confidence: bestSimilarity * 0.9,
			};
		}
		return null;
	}

	private tryAstAwareMatch(
		_targetText: string,
		_currentContent: string,
		_originalRange: Range,
	): Omit<MatchResult, 'strategy' | 'strategyName'> | null {
		// Stub: AST-aware matching requires tree-sitter integration.
		// Will be wired when tree-sitter grammars are available.
		return null;
	}

	private tryFuzzyEditDistance(
		targetText: string,
		currentLines: string[],
		originalRange: Range,
	): Omit<MatchResult, 'strategy' | 'strategyName'> | null {
		const lineCount = originalRange.endLine - originalRange.startLine + 1;

		for (let startIdx = 0; startIdx + lineCount <= currentLines.length; startIdx++) {
			const currentSlice = currentLines.slice(startIdx, startIdx + lineCount).join('\n');
			const distance = this.levenshteinDistance(targetText, currentSlice);
			const normalized = distance / Math.max(lineCount, 1);

			if (normalized < 0.3) {
				return {
					originalRange,
					matchedRange: {
						startLine: startIdx + 1,
						startColumn: originalRange.startColumn,
						endLine: startIdx + lineCount,
						endColumn: originalRange.endColumn,
					},
					confidence: 1 - normalized,
				};
			}
		}
		return null;
	}

	private trySemanticContextMatch(
		targetLines: string[],
		originalLines: string[],
		currentLines: string[],
		originalRange: Range,
	): Omit<MatchResult, 'strategy' | 'strategyName'> | null {
		// Find enclosing function/class in original content
		const scopeName = this.findEnclosingScope(originalLines, originalRange.startLine - 1);
		if (!scopeName) { return null; }

		// Find the same scope in current content
		for (let i = 0; i < currentLines.length; i++) {
			if (currentLines[i].includes(scopeName)) {
				// Found the scope — try to match target lines within it
				const scopeEnd = this.findScopeEnd(currentLines, i);
				const lineCount = targetLines.length;

				for (let j = i; j + lineCount <= scopeEnd; j++) {
					const candidate = currentLines.slice(j, j + lineCount).join('\n');
					const similarity = this.computeSimilarity(targetLines.join('\n'), candidate);
					if (similarity > 0.7) {
						return {
							originalRange,
							matchedRange: {
								startLine: j + 1,
								startColumn: originalRange.startColumn,
								endLine: j + lineCount,
								endColumn: originalRange.endColumn,
							},
							confidence: similarity * 0.7,
						};
					}
				}
			}
		}
		return null;
	}

	private findEnclosingScope(lines: string[], lineIdx: number): string | null {
		const scopePattern = /(?:function|class|method|def)\s+(\w+)/;
		for (let i = lineIdx; i >= 0; i--) {
			const match = scopePattern.exec(lines[i]);
			if (match) { return match[1]; }
		}
		return null;
	}

	private findScopeEnd(lines: string[], scopeStart: number): number {
		let depth = 0;
		let foundOpen = false;
		for (let i = scopeStart; i < lines.length; i++) {
			for (const ch of lines[i]) {
				if (ch === '{') { depth++; foundOpen = true; }
				if (ch === '}') { depth--; }
			}
			if (foundOpen && depth <= 0) { return i + 1; }
		}
		return Math.min(scopeStart + 50, lines.length);
	}

	private computeSimilarity(a: string, b: string): number {
		if (a === b) { return 1.0; }
		if (a.length === 0 || b.length === 0) { return 0; }
		const distance = this.levenshteinDistance(a, b);
		const maxLen = Math.max(a.length, b.length);
		return 1 - distance / maxLen;
	}

	private levenshteinDistance(a: string, b: string): number {
		if (a.length > 1000 || b.length > 1000) {
			// For large strings, use line-level comparison
			return this.lineLevelDistance(a.split('\n'), b.split('\n'));
		}

		const m = a.length;
		const n = b.length;
		const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

		for (let i = 1; i <= m; i++) {
			let prev = dp[0];
			dp[0] = i;
			for (let j = 1; j <= n; j++) {
				const tmp = dp[j];
				if (a[i - 1] === b[j - 1]) {
					dp[j] = prev;
				} else {
					dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
				}
				prev = tmp;
			}
		}
		return dp[n];
	}

	private lineLevelDistance(aLines: string[], bLines: string[]): number {
		const m = aLines.length;
		const n = bLines.length;
		const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);

		for (let i = 1; i <= m; i++) {
			let prev = dp[0];
			dp[0] = i;
			for (let j = 1; j <= n; j++) {
				const tmp = dp[j];
				if (aLines[i - 1] === bLines[j - 1]) {
					dp[j] = prev;
				} else {
					dp[j] = 1 + Math.min(prev, dp[j], dp[j - 1]);
				}
				prev = tmp;
			}
		}
		return dp[n];
	}
}
