/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for `pipelineValidate.ts` — Phase 5 step 5.G.4. Mirror of the
 * daemon's compile-time ordering rules.
 */

import * as assert from 'assert';

import { validatePipeline } from '../src/qviz/pipelineValidate';
import type { Transform } from '../src/qviz/spec';

const filter: Transform = { kind: 'filter', column: 'a', op: '>', value: 0 };
const groupby: Transform = { kind: 'groupby', columns: ['k'] };
const aggregate: Transform = {
	kind: 'aggregate', aggs: [{ column: 'v', fn: 'sum', as: 'v_sum' }],
};
const sort: Transform = { kind: 'sort', columns: [{ column: 'k' }] };
const limit: Transform = { kind: 'limit', n: 100 };

suite('pipelineValidate -- happy paths', () => {

	test('empty pipeline produces no errors', () => {
		assert.deepStrictEqual(validatePipeline([]), {});
	});

	test('filter + sort + limit produces no errors', () => {
		assert.deepStrictEqual(validatePipeline([filter, sort, limit]), {});
	});

	test('groupby immediately followed by aggregate is valid', () => {
		assert.deepStrictEqual(validatePipeline([filter, groupby, aggregate, sort]), {});
	});

});

suite('pipelineValidate -- ordering errors', () => {

	test('groupby at end of pipeline is flagged', () => {
		const errors = validatePipeline([filter, groupby]);
		assert.ok(errors[1]);
		assert.ok(/groupby must be immediately followed by aggregate/.test(errors[1]));
	});

	test('groupby followed by non-aggregate is flagged', () => {
		const errors = validatePipeline([groupby, sort, aggregate]);
		assert.ok(errors[0], 'groupby at 0 must be flagged');
		assert.ok(errors[2], 'orphaned aggregate at 2 must be flagged');
	});

	test('aggregate at start of pipeline is flagged', () => {
		const errors = validatePipeline([aggregate]);
		assert.ok(errors[0]);
		assert.ok(/aggregate must be immediately preceded by groupby/.test(errors[0]));
	});

	test('aggregate preceded by non-groupby is flagged', () => {
		const errors = validatePipeline([filter, aggregate]);
		assert.ok(errors[1]);
	});

	test('two groupbys in a row: first one is flagged', () => {
		const errors = validatePipeline([groupby, groupby, aggregate]);
		// First groupby's "next" is groupby, not aggregate — error.
		assert.ok(errors[0]);
		// Second groupby's "next" IS aggregate — no error.
		assert.strictEqual(errors[1], undefined);
	});

});
