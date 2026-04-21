/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SearchResult } from './vectorIndex.js';

const DEFAULT_RRF_WEIGHTS: Record<string, number> = {
	bm25: 0.4,
	vector: 0.4,
	recency: 0.1,
	'file-proximity': 0.1,
};

/**
 * Reciprocal Rank Fusion reranker (Audit S-10 / I-SG8).
 * Formula: score(doc) = SUM weight_i / (k + rank_i)
 */
export class RRFReranker {
	private readonly k = 60;

	rerank(
		sources: Array<{ results: SearchResult[]; weight: number; name: string }>,
		maxResults = 20,
	): SearchResult[] {
		const docScores = new Map<string, { score: number; result: SearchResult }>();

		for (const source of sources) {
			const weight = source.weight ?? DEFAULT_RRF_WEIGHTS[source.name] ?? 0.1;

			for (let rank = 0; rank < source.results.length; rank++) {
				const result = source.results[rank];
				const key = `${result.filePath}:${result.lineRange?.start ?? 0}`;
				const contribution = weight / (this.k + rank + 1);

				const existing = docScores.get(key);
				if (existing) {
					existing.score += contribution;
					existing.result.source = 'hybrid';
				} else {
					docScores.set(key, {
						score: contribution,
						result: { ...result },
					});
				}
			}
		}

		const sorted = [...docScores.values()]
			.sort((a, b) => b.score - a.score)
			.slice(0, maxResults);

		return sorted.map(entry => ({
			...entry.result,
			score: entry.score,
		}));
	}
}
