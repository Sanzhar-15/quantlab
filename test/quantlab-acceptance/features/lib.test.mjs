/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// node --test test/quantlab-acceptance/features/lib.test.mjs

import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { assemble, CHECK_IDS, findBuiltInExtensionDir, judgePinnedDependency, readForkSha, readPins, treeDigest } from './lib.mjs';

const pins = [
	{ name: 'ms-python.python', version: '2026.4.0' },
	{ name: 'detachhead.basedpyright', version: '1.40.2' },
	{ name: 'ms-toolsai.jupyter', version: '2025.9.1' },
];

test('readPins: the three versions; a missing, doubled or versionless pin throws by name', () => {
	assert.deepStrictEqual(readPins({ builtInExtensions: pins }), { 'ms-python.python': '2026.4.0', 'detachhead.basedpyright': '1.40.2', 'ms-toolsai.jupyter': '2025.9.1' });
	assert.throws(() => readPins({}), /pins_unreadable/);
	assert.throws(() => readPins({ builtInExtensions: pins.slice(1) }), /names ms-python.python 0 times/);
	assert.throws(() => readPins({ builtInExtensions: [...pins, pins[0]] }), /names ms-python.python 2 times/);
	assert.throws(() => readPins({ builtInExtensions: [{ name: 'ms-python.python' }, pins[1], pins[2]] }), /no version for ms-python.python/);
});

test('readForkSha: a 40-hex commit, anything else throws', () => {
	assert.strictEqual(readForkSha({ commit: 'a'.repeat(40) }), 'a'.repeat(40));
	assert.throws(() => readForkSha({}), /fork_sha_unreadable/);
	assert.throws(() => readForkSha({ commit: 'abc' }), /fork_sha_unreadable/);
});

test('assemble: rc 0 only when all five are PASS; NOT RUN, an unreported check and an unknown status are non-zero', () => {
	const all = Object.fromEntries(CHECK_IDS.map(id => [id, { status: 'PASS', detail: 'ok' }]));
	assert.strictEqual(assemble(all).rc, 0);
	assert.strictEqual(assemble({ ...all, import: { status: 'NOT RUN', detail: 'x' } }).rc, 1);
	const missing = assemble({ ...all, import: undefined });
	assert.deepStrictEqual([missing.rc, missing.checks[4].status, /check_unreported/.test(missing.checks[4].detail)], [1, 'FAIL', true]);
	const odd = assemble({ ...all, import: { status: 'GREEN', detail: 'x' } });
	assert.deepStrictEqual([odd.rc, odd.checks[4].status], [1, 'FAIL']);
	assert.deepStrictEqual(assemble({}).checks.map(check => check.id), CHECK_IDS);
});

test('judgePinnedDependency: PASS needs a clean app AND a control that names exactly the removed pin', () => {
	const ok = { ok: true, missing: [], lines: [] };
	const named = { ok: false, missing: ['detachhead.basedpyright'], lines: ['[pinned_dependency_missing] detachhead.basedpyright 1.40.2'] };
	assert.strictEqual(judgePinnedDependency(ok, named, 'detachhead.basedpyright').status, 'PASS');
	assert.strictEqual(judgePinnedDependency(ok, ok, 'detachhead.basedpyright').status, 'FAIL');
	assert.strictEqual(judgePinnedDependency(named, named, 'detachhead.basedpyright').status, 'FAIL');
	assert.strictEqual(judgePinnedDependency(ok, { ok: false, missing: ['ms-toolsai.jupyter'], lines: ['x'] }, 'detachhead.basedpyright').status, 'FAIL');
	assert.strictEqual(judgePinnedDependency(ok, undefined, 'detachhead.basedpyright').status, 'NOT RUN');
});

test('treeDigest and findBuiltInExtensionDir on a small tree', () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ql-features-lib-'));
	try {
		fs.mkdirSync(path.join(root, 'ext', 'ms-python.python'), { recursive: true });
		fs.mkdirSync(path.join(root, 'ext', 'other'));
		fs.writeFileSync(path.join(root, 'ext', 'ms-python.python', 'package.json'), JSON.stringify({ publisher: 'ms-python', name: 'python' }));
		fs.writeFileSync(path.join(root, 'ext', 'other', 'package.json'), JSON.stringify({ publisher: 'x', name: 'y' }));
		assert.strictEqual(findBuiltInExtensionDir(path.join(root, 'ext'), 'ms-python.python'), path.join(root, 'ext', 'ms-python.python'));
		assert.throws(() => findBuiltInExtensionDir(path.join(root, 'ext'), 'ms-toolsai.jupyter'), /builtin_not_found/);
		const before = treeDigest(root);
		assert.strictEqual(before.files, 2);
		assert.deepStrictEqual(treeDigest(root), before);
		fs.writeFileSync(path.join(root, 'ext', 'other', 'package.json'), JSON.stringify({ publisher: 'x', name: 'z' }));
		assert.notStrictEqual(treeDigest(root).sha256, before.sha256);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
