/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * FE-1.5-1d-1 -- unit tests for ReactiveKernelManager (vscode-free; fakes the transport client).
 *
 * Verifies the per-Session orchestration: trust-gate-first, lazy-spawn keyed by session identity,
 * concurrent-start dedup, re-spawn-on-next-use after a close, and disposeSession / disposeAll.
 * Runs in the normal mocha suite (no ipykernel needed -- the real-kernel path is the standalone
 * reactive_kernel_harness.cjs).
 */

import * as assert from 'assert';

import { ReactiveKernelManager, type ReactiveKernelClientLike } from '../src/quantbook/reactiveKernel/reactiveKernelManager';
import type { ReactiveOpResult } from '../src/quantbook/reactiveKernel/reactiveKernelClient';
import type { PublishedRange } from '../src/quantbook/reactiveKernel/publishedCellsStore';

class FakeClient implements ReactiveKernelClientLike {
	started = false;
	disposeCount = 0;
	executed: string[] = [];
	// W-G: per-sheet published ranges the test seeds to verify the manager delegates per (session, sheet).
	publishedBySheet = new Map<number, PublishedRange[]>();
	private closeListener: ((err: Error | undefined) => void) | undefined;
	private startGate: Promise<void> | undefined;
	private releaseStartGate: (() => void) | undefined;

	constructor(private readonly failStart = false, deferred = false) {
		if (deferred) {
			this.startGate = new Promise<void>((res) => {
				this.releaseStartGate = res;
			});
		}
	}

	async start(): Promise<void> {
		if (this.startGate !== undefined) {
			await this.startGate; // a deferred start parks here until releaseStart()
		}
		if (this.failStart) {
			throw new Error('spawn failed');
		}
		this.started = true;
	}
	/** Let a deferred start() proceed (used to drive dispose-during-startup races). */
	releaseStart(): void {
		if (this.releaseStartGate !== undefined) {
			this.releaseStartGate();
		}
	}
	async execute(code: string): Promise<ReactiveOpResult> {
		this.executed.push(code);
		return { republishCount: 1, refused: [], stale: [] };
	}
	async epochChange(): Promise<ReactiveOpResult> {
		return { republishCount: 0, refused: [], stale: [] };
	}
	publishedCellsForSheet(sheet: number): PublishedRange[] {
		return this.publishedBySheet.get(sheet) ?? [];
	}
	async close(): Promise<void> {
		/* no-op fake */
	}
	async dispose(): Promise<void> {
		this.disposeCount++;
	}
	onClose(listener: (err: Error | undefined) => void): void {
		this.closeListener = listener;
	}
	simulateClose(err?: Error): void {
		if (this.closeListener !== undefined) {
			this.closeListener(err);
		}
	}
}

suite('ReactiveKernelManager', () => {
	test('start lazy-spawns one client per session and reuses it', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {
				/* trusted */
			},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
		);
		const sess = {};
		await mgr.start(sess);
		await mgr.start(sess); // reuse, not re-spawn
		assert.strictEqual(made.length, 1, 'exactly one client spawned for one session');
		assert.strictEqual(made[0].started, true);
		assert.strictEqual(mgr.hasKernel(sess), true);
	});

	test('keys by session identity (distinct sessions get distinct kernels)', async () => {
		let n = 0;
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				n++;
				return new FakeClient();
			},
		);
		await mgr.start({});
		await mgr.start({});
		assert.strictEqual(n, 2, 'two distinct sessions -> two kernels');
	});

	test('concurrent start dedups to a single spawn', async () => {
		let n = 0;
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				n++;
				return new FakeClient();
			},
		);
		const sess = {};
		await Promise.all([mgr.start(sess), mgr.start(sess), mgr.start(sess)]);
		assert.strictEqual(n, 1, 'a concurrent start must not spawn three kernels');
	});

	test('executeCell lazy-spawns then runs the cell', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
		);
		const sess = {};
		const r = await mgr.executeCell(sess, 'x = 7');
		assert.strictEqual(made.length, 1);
		assert.deepStrictEqual(made[0].executed, ['x = 7']);
		assert.strictEqual(r.republishCount, 1);
	});

	test('trust gate is checked GATE-FIRST: an untrusted workspace never spawns', async () => {
		let spawned = 0;
		let trusted = false;
		const mgr = new ReactiveKernelManager<object>(
			() => {
				if (!trusted) {
					throw new Error('[kernel_untrusted_workspace] refusing to spawn');
				}
			},
			() => {
				spawned++;
				return new FakeClient();
			},
		);
		const sess = {};
		await assert.rejects(() => mgr.start(sess), /kernel_untrusted_workspace/);
		await assert.rejects(() => mgr.executeCell(sess, 'x = 1'), /kernel_untrusted_workspace/);
		assert.strictEqual(spawned, 0, 'no client may be created while untrusted');
		assert.strictEqual(mgr.hasKernel(sess), false);
		// once trusted, it spawns
		trusted = true;
		await mgr.start(sess);
		assert.strictEqual(spawned, 1);
	});

	test('a closed kernel deregisters and the next use re-spawns', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
		);
		const sess = {};
		await mgr.start(sess);
		assert.strictEqual(mgr.hasKernel(sess), true);
		made[0].simulateClose(new Error('kernel crashed'));
		assert.strictEqual(mgr.hasKernel(sess), false, 'a closed kernel must deregister');
		await mgr.start(sess);
		assert.strictEqual(made.length, 2, 'next use re-spawns a fresh kernel');
	});

	test('a failed start does not leave a registered kernel', async () => {
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => new FakeClient(true /* failStart */),
		);
		const sess = {};
		await assert.rejects(() => mgr.start(sess), /spawn failed/);
		assert.strictEqual(mgr.hasKernel(sess), false);
	});

	test('retry after a failed start succeeds (no stuck starting entry)', async () => {
		let n = 0;
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				n++;
				return new FakeClient(n === 1 /* the first attempt fails */);
			},
		);
		const sess = {};
		await assert.rejects(() => mgr.start(sess), /spawn failed/);
		assert.strictEqual(mgr.hasKernel(sess), false);
		await mgr.start(sess); // a second attempt must be allowed (no stuck `starting` entry)
		assert.strictEqual(n, 2);
		assert.strictEqual(mgr.hasKernel(sess), true);
	});

	test('disposeSession DURING startup cancels + disposes the in-flight kernel (never registers it)', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient(false, true /* deferred start */);
				made.push(c);
				return c;
			},
		);
		const sess = {};
		const startP = mgr.start(sess); // parked at the deferred start gate
		const settled = startP.then(() => 'resolved', () => 'rejected');
		await mgr.disposeSession(sess); // cancel mid-start
		made[0].releaseStart(); // now let the gated start() resolve
		assert.strictEqual(await settled, 'rejected', 'a cancelled start must reject');
		assert.strictEqual(mgr.hasKernel(sess), false, 'a cancelled start must NOT register');
		assert.ok(made[0].disposeCount >= 1, 'the in-flight kernel must be disposed');
	});

	test('disposeAll DURING startup disposes the in-flight kernel', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient(false, true /* deferred start */);
				made.push(c);
				return c;
			},
		);
		const sess = {};
		const startP = mgr.start(sess);
		const settled = startP.then(() => 'resolved', () => 'rejected');
		await mgr.disposeAll();
		made[0].releaseStart();
		await settled;
		assert.strictEqual(mgr.hasKernel(sess), false);
		assert.ok(made[0].disposeCount >= 1, 'disposeAll must dispose an in-flight kernel');
	});

	test('disposeSession tears the kernel down (no-op if none)', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
		);
		const sess = {};
		await mgr.start(sess);
		await mgr.disposeSession(sess);
		assert.strictEqual(made[0].disposeCount, 1);
		assert.strictEqual(mgr.hasKernel(sess), false);
		await mgr.disposeSession(sess); // idempotent / no-op
		assert.strictEqual(made[0].disposeCount, 1);
	});

	test('disposeAll disposes every kernel and clears the registry', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
		);
		const a = {};
		const b = {};
		await mgr.start(a);
		await mgr.start(b);
		await mgr.disposeAll();
		assert.strictEqual(made.length, 2);
		assert.strictEqual(made[0].disposeCount, 1);
		assert.strictEqual(made[1].disposeCount, 1);
		assert.strictEqual(mgr.hasKernel(a), false);
		assert.strictEqual(mgr.hasKernel(b), false);
	});

	test('publishedCellsForSheet delegates to the session client per sheet; [] when no kernel', async () => {
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
		);
		const sess = {};
		// No kernel registered yet for the session -> [] (the render path stays safe before any start).
		assert.deepStrictEqual(mgr.publishedCellsForSheet(sess, 0), []);
		await mgr.start(sess);
		const ranges: PublishedRange[] = [{ startRow: 0, startCol: 1, endRow: 0, endCol: 1, name: 'x' }];
		made[0].publishedBySheet.set(0, ranges);
		assert.deepStrictEqual(mgr.publishedCellsForSheet(sess, 0), ranges, 'surfaces the client ranges for the sheet');
		assert.deepStrictEqual(mgr.publishedCellsForSheet(sess, 1), [], 'another sheet has none');
		assert.deepStrictEqual(mgr.publishedCellsForSheet({}, 0), [], 'an unknown session has no kernel');
	});

	test('onClientRemoved fires once on disposeSession and on an unexpected close (badge cleanup hook)', async () => {
		const removed: object[] = [];
		const made: FakeClient[] = [];
		const mgr = new ReactiveKernelManager<object>(
			() => {},
			() => {
				const c = new FakeClient();
				made.push(c);
				return c;
			},
			(s) => removed.push(s),
		);
		const a = {};
		await mgr.start(a);
		await mgr.disposeSession(a);
		assert.deepStrictEqual(removed, [a], 'disposeSession of a registered client fires the hook once');

		const b = {};
		await mgr.start(b);
		made[1].simulateClose(); // crash/EOF: the manager's onClose listener removes + fires the hook
		assert.deepStrictEqual(removed, [a, b], 'an unexpected close fires the hook');
		assert.strictEqual(mgr.hasKernel(b), false, 'the closed client is deregistered');
	});
});
