/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for the save-decision pure function — Phase 5 step C megaudit
 * fix C14. Prior provider had zero tests; the save logic was tangled
 * with vscode runtime so unit-testing required a heavyweight mock.
 * Extracting `decideSave` to a pure function lets us test every branch
 * directly.
 */

import * as assert from 'assert';

import { decideSave, type DriftStatusForSave } from '../src/qviz/saveDecision';
import type { SchemaInfo } from '../src/qviz/messageProtocol';

const HASH_A = 'sha256:' + 'a'.repeat(64);
const HASH_B = 'sha256:' + 'b'.repeat(64);

function liveSchema(): SchemaInfo {
	return {
		uri: 'data/x.parquet',
		schema_hash: HASH_B,
		mtime_ns: 100,
		row_count: 200,
		columns: [{ name: 'a', dtype: 'float64', nullable: false }],
	};
}

suite('saveDecision -- refuse paths', () => {

	test('idle status refuses with retry message', () => {
		const d = decideSave({ kind: 'idle' });
		assert.strictEqual(d.action, 'refuse');
		if (d.action !== 'refuse') { return; }
		assert.strictEqual(d.reason, 'idle');
		assert.ok(/has not started/.test(d.userMessage), d.userMessage);
	});

	test('in-flight status refuses with retry message', () => {
		const d = decideSave({ kind: 'in-flight' });
		assert.strictEqual(d.action, 'refuse');
		if (d.action !== 'refuse') { return; }
		assert.strictEqual(d.reason, 'in-flight');
		assert.ok(/in progress/.test(d.userMessage), d.userMessage);
	});

	test('failed status refuses with the underlying error', () => {
		const d = decideSave({ kind: 'failed', error: 'daemon spawn failed' });
		assert.strictEqual(d.action, 'refuse');
		if (d.action !== 'refuse') { return; }
		assert.strictEqual(d.reason, 'failed');
		assert.ok(/daemon spawn failed/.test(d.userMessage), d.userMessage);
	});

	test('detected fields-missing refuses, listing the broken fields', () => {
		const d = decideSave({
			kind: 'detected',
			result: {
				drift: 'fields-missing',
				oldHash: HASH_A, newHash: HASH_B,
				missingFields: ['gone1', 'gone2'],
			},
			liveSchema: liveSchema(),
		});
		assert.strictEqual(d.action, 'refuse');
		if (d.action !== 'refuse') { return; }
		assert.strictEqual(d.reason, 'fields-missing');
		assert.ok(/gone1, gone2/.test(d.userMessage), d.userMessage);
	});

});

suite('saveDecision -- save paths', () => {

	test('detected same-hash → verbatim save', () => {
		const d = decideSave({
			kind: 'detected',
			result: {
				drift: 'same-hash',
				oldHash: HASH_A, newHash: HASH_A,
				missingFields: [],
			},
			liveSchema: liveSchema(),
		});
		assert.strictEqual(d.action, 'verbatim');
	});

	test('detected fields-preserved → with-refresh, carrying liveSchema', () => {
		const schema = liveSchema();
		const d = decideSave({
			kind: 'detected',
			result: {
				drift: 'fields-preserved',
				oldHash: HASH_A, newHash: HASH_B,
				missingFields: [],
			},
			liveSchema: schema,
		});
		assert.strictEqual(d.action, 'with-refresh');
		if (d.action !== 'with-refresh') { return; }
		assert.strictEqual(d.liveSchema, schema);
	});

});

suite('saveDecision -- exhaustiveness', () => {

	test('every documented status kind is handled (no fall-through)', () => {
		// Every kind of `DriftStatusForSave`:
		const statuses: DriftStatusForSave[] = [
			{ kind: 'idle' },
			{ kind: 'in-flight' },
			{ kind: 'failed', error: 'x' },
			{
				kind: 'detected',
				result: { drift: 'same-hash', oldHash: HASH_A, newHash: HASH_A, missingFields: [] },
				liveSchema: liveSchema(),
			},
			{
				kind: 'detected',
				result: { drift: 'fields-preserved', oldHash: HASH_A, newHash: HASH_B, missingFields: [] },
				liveSchema: liveSchema(),
			},
			{
				kind: 'detected',
				result: { drift: 'fields-missing', oldHash: HASH_A, newHash: HASH_B, missingFields: ['x'] },
				liveSchema: liveSchema(),
			},
		];
		for (const s of statuses) {
			const d = decideSave(s);
			// Every one returns one of three actions, never undefined.
			assert.ok(['refuse', 'verbatim', 'with-refresh'].includes(d.action),
				`unexpected action for status ${s.kind}: ${d.action}`);
		}
	});

});
