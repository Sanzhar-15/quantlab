/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { RRFReranker } from '../../../common/context/reranker.js';
import type { SearchResult } from '../../../common/context/vectorIndex.js';

suite('RRFReranker', () => {

	let reranker: RRFReranker;

	setup(() => {
		reranker = new RRFReranker();
	});

	function makeResult(filePath: string, score: number, source: SearchResult['source'] = 'bm25'): SearchResult {
		return { filePath, content: '', score, source };
	}

	test('reranks single source correctly', () => {
		const results = reranker.rerank([
			{
				results: [makeResult('a.ts', 10), makeResult('b.ts', 5)],
				weight: 1.0,
				name: 'bm25',
			},
		]);
		assert.strictEqual(results.length, 2);
		assert.strictEqual(results[0].filePath, 'a.ts');
		assert.strictEqual(results[1].filePath, 'b.ts');
	});

	test('combines multiple sources with RRF formula', () => {
		const results = reranker.rerank([
			{
				results: [makeResult('a.ts', 10), makeResult('b.ts', 5)],
				weight: 0.4,
				name: 'bm25',
			},
			{
				results: [makeResult('b.ts', 10), makeResult('a.ts', 5)],
				weight: 0.4,
				name: 'vector',
			},
		]);
		// Both a.ts and b.ts appear in both sources
		assert.strictEqual(results.length, 2);
		// Scores should be close since both appear at rank 1 in one source and rank 2 in another
		assert.ok(results[0].source === 'hybrid');
	});

	test('respects maxResults', () => {
		const results = reranker.rerank([
			{
				results: Array.from({ length: 30 }, (_, i) => makeResult(`file-${i}.ts`, 30 - i)),
				weight: 0.4,
				name: 'bm25',
			},
		], 5);
		assert.strictEqual(results.length, 5);
	});

	test('handles empty sources', () => {
		const results = reranker.rerank([]);
		assert.strictEqual(results.length, 0);
	});

	test('applies correct weights (BM25=0.4, vector=0.4)', () => {
		const results = reranker.rerank([
			{
				results: [makeResult('only-bm25.ts', 10)],
				weight: 0.4,
				name: 'bm25',
			},
			{
				results: [makeResult('only-vector.ts', 10)],
				weight: 0.4,
				name: 'vector',
			},
		]);
		// Both should have the same score since same weight and rank
		assert.strictEqual(results.length, 2);
		assert.ok(Math.abs(results[0].score - results[1].score) < 0.001);
	});
});
