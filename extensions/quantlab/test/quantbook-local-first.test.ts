/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Wave J-a (R16) -- unit tests for the local-first messaging surface (pure model). The load-bearing tests
// are the HONESTY guards. A pre-commit megaudit (Codex + Opus + Sonnet) found that the wider Quantlab app
// has many egress paths (Anthropic, the Delta Plus cloud incl. file-uploading server tools, broker APIs),
// and that the AI "never sends" categories are best-effort regex, not enforced. So the statement must:
//   - make ONLY the true, narrow workbook guarantee (computes locally, not uploaded),
//   - NAME the real egress (AI -> Anthropic, Delta Plus cloud, broker integrations), and
//   - NOT over-claim an exhaustive "only things that use the network" or a hard "never sends".
// These tests pin all of that so the honesty fix cannot silently regress.

import * as assert from 'assert';

import {
	LOCAL_FIRST_HEADLINE,
	LOCAL_GUARANTEE,
	buildLocalFirstDetail,
	buildShieldTooltip,
} from '../src/quantbook/shell/localFirstModel';

suite('Quantbook local-first messaging (R16) -- buildLocalFirstDetail', () => {
	const detail = buildLocalFirstDetail();

	test('states the workbook local guarantee (cells/formulas/Python/SQL run locally, not uploaded)', () => {
		assert.ok(detail.includes(LOCAL_GUARANTEE), 'detail must lead with the local guarantee');
		assert.ok(detail.includes('run locally in the built-in engine'), 'names local execution');
		assert.ok(detail.includes('does not upload your workbook'), 'states the workbook is not uploaded');
	});

	test('HONESTY: names the Delta Plus cloud egress incl. server-tool file upload', () => {
		assert.ok(detail.includes('Quantlab account'), 'must mention cloud sign-in');
		assert.ok(detail.includes('Delta Plus'), 'must name the Delta Plus backend');
		assert.ok(detail.includes('market data'), 'must mention market data');
		assert.ok(detail.includes('upload'), 'must disclose that a server-side tool can upload a data file');
	});

	test('names no removed path: the AI panel and the broker integrations are not in the product', () => {
		assert.ok(!/Anthropic|AI assistance|Alpaca|broker/i.test(detail), detail);
		assert.strictEqual(detail.split('\n').filter(line => line.startsWith('* ')).length, 1, 'one network bullet: the cloud services');
	});

	test('HONESTY guard: does NOT over-claim an absolute or an unenforced guarantee', () => {
		// We make a SCOPED, true claim (the WORKBOOK is local). We must never assert an app-wide absolute
		// ("nothing leaves" / "the only things that use the network") or a hard "never sends" the code does
		// not enforce -- the megaudit found both to be falsifiable against the wider Quantlab app.
		assert.ok(!detail.includes('never leaves your machine'), 'no absolute "never leaves"');
		assert.ok(!detail.toLowerCase().includes('nothing ever leaves'), 'no absolute "nothing ever leaves"');
		assert.ok(!detail.toLowerCase().includes('only things that use the network'), 'no exhaustive-list absolute');
		assert.ok(!detail.includes('never sends'), 'no unenforced hard "never sends" guarantee');
	});
});

suite('Quantbook local-first messaging (R16) -- buildShieldTooltip + headline', () => {
	test('headline is a short non-empty title', () => {
		assert.ok(LOCAL_FIRST_HEADLINE.length > 0);
		assert.ok(LOCAL_FIRST_HEADLINE.includes('local-first'));
	});

	test('tooltip summarizes locality and invites the detail', () => {
		const tip = buildShieldTooltip();
		assert.ok(tip.includes('local-first'), 'tooltip names the guarantee');
		assert.ok(tip.toLowerCase().includes('network'), 'tooltip invites the network detail');
	});
});
