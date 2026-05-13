/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pin the `error_kind` contract on the TS side (megaudit F3).
 *
 * The decoder at `daemon-client.ts:decodeDaemonErrorKind` accepts the
 * six known kinds and refuses anything else as `DaemonProtocolError`.
 * Per CLAUDE.md "no fallbacks" we explicitly do NOT default to
 * `'compile'` for unknown values — silent classification drift between
 * Python and TS was the original bug.
 *
 * Plus the load-bearing cross-side sentinel: scrape `daemon.py` for
 * `"error_kind": "..."` literals and assert the set matches the TS
 * `DAEMON_ERROR_KINDS`. A one-side rename (`compile` -> `compiler` or
 * adding a new kind on one side) breaks this immediately.
 */

import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
	DAEMON_ERROR_KINDS,
	DaemonProtocolError,
	decodeDaemonErrorKind,
	type DaemonErrorKind,
} from '../src/qviz/daemon-client';

suite('error_kind contract -- decodeDaemonErrorKind', () => {

	for (const kind of ['compile', 'security', 'timeout', 'memory', 'internal', 'protocol'] as const) {
		test(`accepts "${kind}"`, () => {
			assert.strictEqual(decodeDaemonErrorKind(kind, 'aggregate'), kind);
		});
	}

	test('rejects unknown string with DaemonProtocolError (no fallback)', () => {
		assert.throws(
			() => decodeDaemonErrorKind('compiler', 'aggregate'),
			(e: Error) => e instanceof DaemonProtocolError
				&& /invalid error_kind/.test(e.message),
			'rename drift like "compile"->"compiler" must surface as DaemonProtocolError',
		);
	});

	test('rejects missing (undefined) with DaemonProtocolError', () => {
		assert.throws(
			() => decodeDaemonErrorKind(undefined, 'aggregate'),
			(e: Error) => e instanceof DaemonProtocolError,
		);
	});

	test('rejects null with DaemonProtocolError', () => {
		assert.throws(
			() => decodeDaemonErrorKind(null, 'aggregate'),
			(e: Error) => e instanceof DaemonProtocolError,
		);
	});

	test('rejects non-string types with DaemonProtocolError', () => {
		for (const v of [42, true, [], {}]) {
			assert.throws(
				() => decodeDaemonErrorKind(v, 'op'),
				(e: Error) => e instanceof DaemonProtocolError,
				`expected throw for ${JSON.stringify(v)}`,
			);
		}
	});

	test('DAEMON_ERROR_KINDS contains exactly six entries', () => {
		assert.strictEqual(
			DAEMON_ERROR_KINDS.size, 6,
			`expected 6 known error kinds, got ${DAEMON_ERROR_KINDS.size}: ${[...DAEMON_ERROR_KINDS]}`,
		);
	});

	test('cross-side: TS DAEMON_ERROR_KINDS matches daemon.py emissions', () => {
		// Scrape every literal `"error_kind": "<kind>"` from the
		// daemon's handle() ladder. If Python adds a kind without TS
		// catching up (or vice versa), this fails loudly with the
		// diff.
		// __dirname at runtime is out/test/; daemon.py lives at
		// extensions/quantlab/python/qviz/daemon.py = out/test/../../python/qviz/daemon.py.
		const daemonPath = path.resolve(
			__dirname, '..', '..', 'python', 'qviz', 'daemon.py',
		);
		assert.ok(fs.existsSync(daemonPath),
			`daemon.py not found at ${daemonPath}`);
		const src = fs.readFileSync(daemonPath, 'utf8');
		const found = new Set<string>();
		for (const m of src.matchAll(/"error_kind":\s*"(\w+)"/g)) {
			found.add(m[1]);
		}
		const tsKinds = [...DAEMON_ERROR_KINDS].sort();
		const pyKinds = [...found].sort();
		assert.deepStrictEqual(
			pyKinds, tsKinds,
			`error_kind set drift between daemon.py and daemon-client.ts. `
			+ `TS has [${tsKinds.join(', ')}], Python emits [${pyKinds.join(', ')}].`,
		);
	});

});

// Helper: pin the TS type-export shape (catches accidental widening to
// `string`). Not a runtime test — TypeScript's structural check at
// compile time. The variable must be `DaemonErrorKind`.
const _typecheck: DaemonErrorKind[] = [...DAEMON_ERROR_KINDS];
void _typecheck;
