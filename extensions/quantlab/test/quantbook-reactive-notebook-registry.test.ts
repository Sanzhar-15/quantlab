/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5 W-N (N-1) -- unit tests for the vscode-free reactive-notebook registry: bind-on-first-execute,
// the Codex HIGH-1 lifetime fix (detach on close -> PERSISTENT error until the notebook reopens, never a
// dead-session exec), the MED-1 per-session serialization (in-order, poison-resistant, resolve->close
// race closed), and the op-status formatter. Runs in the normal mocha suite (no ipykernel / no vscode).

import * as assert from 'assert';

import {
	formatOpStatus,
	NotebookWorkbookClosedError,
	partialStatusFromError,
	ReactiveNotebookRegistry,
} from '../src/quantbook/reactiveNotebook/reactiveNotebookRegistry';

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
	let resolve!: (v: T) => void;
	let reject!: (e: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

suite('ReactiveNotebookRegistry binding + lifetime', () => {
	test('bind-on-first-execute resolves once, then reuses the same session', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const sessionA = { id: 'A' };
		let calls = 0;
		const resolveFresh = (): object => {
			calls++;
			return sessionA;
		};
		const first = reg.resolveForExecute('nb1', resolveFresh);
		const second = reg.resolveForExecute('nb1', resolveFresh);
		assert.strictEqual(first, sessionA);
		assert.strictEqual(second, sessionA, 'a bound notebook reuses its session');
		assert.strictEqual(calls, 1, 'resolveFresh runs only on first execute');
		assert.strictEqual(reg.boundSession('nb1'), sessionA);
	});

	test('distinct notebooks bind independently', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const a = { id: 'A' };
		const b = { id: 'B' };
		assert.strictEqual(reg.resolveForExecute('nb1', () => a), a);
		assert.strictEqual(reg.resolveForExecute('nb2', () => b), b);
		assert.strictEqual(reg.boundSession('nb1'), a);
		assert.strictEqual(reg.boundSession('nb2'), b);
	});

	test('a resolveFresh that throws (no grid / ambiguous) does NOT bind', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		assert.throws(() => reg.resolveForExecute('nb1', () => {
			throw new Error('[no_cell_grid] none open');
		}), /no_cell_grid/);
		assert.strictEqual(reg.boundSession('nb1'), undefined, 'a failed resolve leaves the notebook unbound');
		// a later successful resolve still binds
		const s = { id: 'S' };
		assert.strictEqual(reg.resolveForExecute('nb1', () => s), s);
	});

	test('HIGH-1 lifetime: a closed session detaches PERSISTENTLY (no silent rebind until the notebook reopens)', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const closed = { id: 'closed' };
		reg.resolveForExecute('nb1', () => closed);
		assert.strictEqual(reg.boundSession('nb1'), closed);

		reg.invalidateSession(closed); // the grid closed its session
		assert.strictEqual(reg.boundSession('nb1'), undefined, 'a closed session must not remain bound');

		// EVERY subsequent execute keeps throwing -- the tombstone PERSISTS so a later cell in the same
		// Run All can never silently rebind to a different grid (Codex HIGH).
		const other = { id: 'other' };
		assert.throws(() => reg.resolveForExecute('nb1', () => other), NotebookWorkbookClosedError);
		assert.throws(() => reg.resolveForExecute('nb1', () => other), NotebookWorkbookClosedError);
		assert.strictEqual(reg.boundSession('nb1'), undefined, 'still not rebound after repeated attempts');

		// Recovery is ONLY via closing + reopening the notebook (invalidateNotebook clears the tombstone).
		reg.invalidateNotebook('nb1');
		assert.strictEqual(reg.resolveForExecute('nb1', () => other), other, 'a reopened notebook binds fresh');
	});

	test('invalidateSession only detaches notebooks bound to THAT session', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const a = { id: 'A' };
		const b = { id: 'B' };
		reg.resolveForExecute('nbA', () => a);
		reg.resolveForExecute('nbB', () => b);
		reg.invalidateSession(a);
		assert.strictEqual(reg.boundSession('nbA'), undefined, 'nbA detached');
		assert.strictEqual(reg.boundSession('nbB'), b, 'nbB untouched');
		// nbA stays detached (throws); nbB just reuses its live binding
		assert.throws(() => reg.resolveForExecute('nbA', () => a), NotebookWorkbookClosedError);
		assert.strictEqual(reg.resolveForExecute('nbB', () => b), b);
	});

	test('two notebooks bound to the SAME session both detach when it closes', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s = { id: 'shared' };
		reg.resolveForExecute('nb1', () => s);
		reg.resolveForExecute('nb2', () => s);
		reg.invalidateSession(s);
		assert.throws(() => reg.resolveForExecute('nb1', () => s), NotebookWorkbookClosedError);
		assert.throws(() => reg.resolveForExecute('nb2', () => s), NotebookWorkbookClosedError);
	});

	test('closing the notebook clears its binding AND any tombstone (reopen starts clean)', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s = { id: 'S' };
		reg.resolveForExecute('nb1', () => s);
		reg.invalidateSession(s); // tombstone nb1
		reg.invalidateNotebook('nb1'); // notebook closed before the error ever surfaced
		// a reopened notebook at the same uri must NOT inherit the stale "workbook closed" error
		const fresh = { id: 'fresh' };
		assert.strictEqual(reg.resolveForExecute('nb1', () => fresh), fresh);
	});

	test('isLiveBinding reflects the current binding (closes the resolve->close race)', () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s = { id: 'S' };
		reg.resolveForExecute('nb1', () => s);
		assert.strictEqual(reg.isLiveBinding('nb1', s), true);
		reg.invalidateSession(s);
		assert.strictEqual(reg.isLiveBinding('nb1', s), false, 'after close the queued task must see a stale binding');
	});
});

suite('ReactiveNotebookRegistry serialization', () => {
	test('serializes tasks for one session in submission order', async () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s = {};
		const log: string[] = [];
		const a = deferred<void>();
		const b = deferred<void>();

		const p1 = reg.serialize(s, async () => {
			await a.promise;
			log.push('a');
		});
		const p2 = reg.serialize(s, async () => {
			await b.promise;
			log.push('b');
		});

		// Release b first; it must still run AFTER a (serialized, not concurrent).
		b.resolve();
		await new Promise((r) => setTimeout(r, 10));
		assert.deepStrictEqual(log, [], 'b must not run while a is still pending');
		a.resolve();
		await Promise.all([p1, p2]);
		assert.deepStrictEqual(log, ['a', 'b'], 'tasks run in submission order');
	});

	test('a rejected task does not poison the chain (the next task still runs)', async () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s = {};
		await assert.rejects(reg.serialize(s, async () => {
			throw new Error('boom');
		}), /boom/);
		const r = await reg.serialize(s, async () => 42);
		assert.strictEqual(r, 42, 'the chain recovers after a failed task');
	});

	test('the returned promise settles with the task result / error', async () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s = {};
		assert.strictEqual(await reg.serialize(s, async () => 'ok'), 'ok');
		await assert.rejects(reg.serialize(s, async () => Promise.reject(new Error('nope'))), /nope/);
	});

	test('distinct sessions run concurrently (independent chains)', async () => {
		const reg = new ReactiveNotebookRegistry<object>();
		const s1 = {};
		const s2 = {};
		const gate = deferred<void>();
		let s2Ran = false;
		const p1 = reg.serialize(s1, async () => {
			await gate.promise; // s1 parks
		});
		const p2 = reg.serialize(s2, async () => {
			s2Ran = true; // s2 must not be blocked by s1
		});
		await p2;
		assert.strictEqual(s2Ran, true, 'a second session is not blocked by the first');
		gate.resolve();
		await p1;
	});
});

suite('formatOpStatus', () => {
	test('reports a recompute count', () => {
		assert.strictEqual(
			formatOpStatus({ republishCount: 3, refused: [], stale: [] }),
			'Recomputed 3 grid ranges from published variables.',
		);
	});

	test('singularizes one range', () => {
		assert.strictEqual(
			formatOpStatus({ republishCount: 1, refused: [], stale: [] }),
			'Recomputed 1 grid range from published variables.',
		);
	});

	test('a read-only op says nothing changed', () => {
		assert.strictEqual(
			formatOpStatus({ republishCount: 0, refused: [], stale: [] }),
			'Ran. No grid cells changed.',
		);
	});

	test('surfaces refusals and stale names', () => {
		const out = formatOpStatus({
			republishCount: 1,
			refused: [{ name: 'x', detail: 'S0!B1 holds a user formula' }],
			stale: ['y', 'z'],
		});
		assert.ok(out.includes('Recomputed 1 grid range'), 'keeps the recompute line');
		assert.ok(out.includes('Refused to overwrite a user formula at x: S0!B1 holds a user formula'));
		assert.ok(out.includes('Stale (unpublished but still referenced): y, z'));
	});
});

suite('partialStatusFromError (publish-then-raise honesty)', () => {
	test('extracts the partial op state a publish-then-raise error carries', () => {
		const err = Object.assign(new Error('reactive kernel error: boom'), {
			republishCount: 2,
			refused: [{ name: 'a', detail: 'd' }],
			stale: ['s'],
		});
		const partial = partialStatusFromError(err);
		assert.deepStrictEqual(partial, { republishCount: 2, refused: [{ name: 'a', detail: 'd' }], stale: ['s'] });
	});

	test('returns undefined for a plain error that published nothing (no misleading status line)', () => {
		assert.strictEqual(partialStatusFromError(new Error('syntax error')), undefined);
		assert.strictEqual(partialStatusFromError(Object.assign(new Error('x'), { republishCount: 0, refused: [], stale: [] })), undefined);
	});

	test('is robust to non-error / malformed inputs', () => {
		assert.strictEqual(partialStatusFromError(undefined), undefined);
		assert.strictEqual(partialStatusFromError(null), undefined);
		assert.strictEqual(partialStatusFromError('a string'), undefined);
		// a partially-shaped object still yields a usable status (only the present, well-typed fields)
		assert.deepStrictEqual(
			partialStatusFromError({ republishCount: 3 }),
			{ republishCount: 3, refused: [], stale: [] },
		);
	});

	test('rejects non-finite / negative counts (no misleading status, no throw) [re-audit MED]', () => {
		// NaN / negative / Infinity counts must NOT yield a status (they would render "no cells changed").
		assert.strictEqual(partialStatusFromError({ republishCount: NaN }), undefined);
		assert.strictEqual(partialStatusFromError({ republishCount: -1 }), undefined);
		assert.strictEqual(partialStatusFromError({ republishCount: Infinity }), undefined);
		// a fractional count is floored
		assert.deepStrictEqual(partialStatusFromError({ republishCount: 2.9 }), { republishCount: 2, refused: [], stale: [] });
	});

	test('filters malformed refused/stale entries so formatOpStatus can never throw [re-audit MED]', () => {
		// refused: [null] (and missing name/detail) must be dropped, not passed to formatOpStatus.
		const withBadRefused = partialStatusFromError({ republishCount: 1, refused: [null, { name: 'x' }, { name: 'y', detail: 'd' }], stale: [1, 'z', null] });
		assert.deepStrictEqual(withBadRefused, { republishCount: 1, refused: [{ name: 'y', detail: 'd' }], stale: ['z'] });
		// and the result must format without throwing
		assert.doesNotThrow(() => formatOpStatus(withBadRefused!));
		// an op whose ONLY signal is a fully-malformed refused list collapses to undefined (nothing to show)
		assert.strictEqual(partialStatusFromError({ republishCount: 0, refused: [null], stale: [] }), undefined);
	});
});
