/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DaemonLifecycle — workspace-keyed lifecycle manager for QvizDaemonClient.
 *
 * Phase 5 step B.3 (audit-merged plan, post-megaudit-cycle-2). Wraps a
 * `QvizDaemonClient` with:
 *   - Lazy spawn on first `getClient()` call.
 *   - Auto-respawn on unexpected daemon close, with exponential backoff
 *     bounded by `maxAttempts` and `maxBackoffMs`.
 *   - A status state machine (`idle / starting / ready / crashed /
 *     respawning / unavailable`) with a subscribable event stream so the
 *     provider and webview can drive UI from it.
 *   - Deterministic dispose: pending callers waiting on `getClient()`
 *     reject with `DaemonUnavailableError`; future calls also reject.
 *
 * Concerns NOT in this module:
 *   - vscode integration (the provider wraps lifecycle status in a
 *     `daemonStatus` postMessage to the webview).
 *   - Capabilities handshake (the daemon-client itself; lifecycle just
 *     waits for `client.ready()` and treats success as "transitioned to
 *     ready").
 *   - Per-workspace storage / spawning policy (callers decide whether to
 *     instantiate a singleton per workspace folder).
 *
 * Step B megaudit-cycle-2 fixes baked in:
 *   - Lifecycle exposes a `LifecycleClient` (Omit<…, 'dispose'>), so
 *     callers can't tear down the client out from under the lifecycle.
 *     Lifecycle disposal is the only authorized teardown path.
 *   - Stale callbacks are filtered by `spawnGeneration AND
 *     this.client === <captured client>`. The "this.client !== captured"
 *     check catches the banner-success / child-death race where ready()
 *     resolves after we've already started a respawn for the next
 *     generation.
 *   - failPending paths in the underlying client now route through
 *     handleClose (force-killing the child), which fires the close
 *     handler. Lifecycle dispatches that as a crash.
 *   - dispose() awaits all in-flight teardown; concurrent dispose() calls
 *     resolve to the same teardown completion.
 *   - Status handler exceptions PROPAGATE -- there is no try/catch
 *     fallback (CLAUDE.md). A buggy handler that throws will abort the
 *     dispatch in transition() and surface to whoever called the
 *     transitioning method.
 *   - All tunables (initialBackoffMs, maxBackoffMs, maxAttempts) are
 *     required on the options object. `DEFAULT_DAEMON_LIFECYCLE_OPTIONS`
 *     is exported; callers spread it explicitly at the call site.
 *   - Retry timer is NOT unref'd while waiters are queued, so Node won't
 *     exit before resolving them.
 */

import {
	QvizDaemonClient,
	type QvizDaemonClientOptions,
	DEFAULT_DAEMON_CLIENT_OPTIONS,
} from './daemon-client';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class DaemonUnavailableError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'DaemonUnavailableError';
	}
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export type LifecycleStatus =
	/** Constructed but no spawn has been attempted yet. */
	| { readonly kind: 'idle' }
	/** A spawn is in flight; transitions to 'ready' on banner, 'crashed'
	 *  on early exit, 'unavailable' on terminal failure. */
	| { readonly kind: 'starting'; readonly attemptNumber: number }
	/** Spawned and banner received. The client is live. */
	| { readonly kind: 'ready' }
	/** Most recent client died unexpectedly. A respawn is scheduled. */
	| {
		readonly kind: 'crashed';
		readonly error: string;
		readonly retryInMs: number;
		readonly attemptNumber: number;
	}
	/** A retry timer fired; new spawn in progress (transient state between
	 *  the timer fire and the new client's `ready()` resolution). */
	/** A retry timer fired; new spawn in progress. Carries the LAST
	 *  crash error so a UI watching status transitions can still show
	 *  "respawning after: <error>" instead of losing context after the
	 *  prior `crashed` state. */
	| {
		readonly kind: 'respawning';
		readonly attemptNumber: number;
		readonly lastError: string;
	}
	/** maxAttempts exhausted, OR an explicit dispose ran. Subsequent
	 *  `getClient()` calls reject with DaemonUnavailableError. */
	| { readonly kind: 'unavailable'; readonly error: string };

export type LifecycleStatusKind = LifecycleStatus['kind'];

// ---------------------------------------------------------------------------
// client surface (no dispose -- lifecycle owns teardown)
// ---------------------------------------------------------------------------

/** Subset of `QvizDaemonClient` exposed via `getClient()`. The `dispose`
 *  method is intentionally hidden so a caller cannot tear down the
 *  client out from under the lifecycle (which would leave the lifecycle
 *  in `ready` state with a closed client; see Step B megaudit C7). */
export type LifecycleClient = Omit<QvizDaemonClient, 'dispose'>;

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface DaemonLifecycleOptions extends QvizDaemonClientOptions {
	/** First retry delay after a crash. */
	readonly initialBackoffMs: number;
	/** Cap on retry delay. Backoff doubles each attempt until it reaches
	 *  this ceiling. */
	readonly maxBackoffMs: number;
	/** Max consecutive failed spawn attempts before transitioning to
	 *  `unavailable`. */
	readonly maxAttempts: number;
}

/** Documented defaults for lifecycle tunables. Callers spread this
 *  explicitly so the call site shows the configuration:
 *
 *      new DaemonLifecycle({
 *          workspaceRoot, pythonPath,
 *          ...DEFAULT_DAEMON_LIFECYCLE_OPTIONS,
 *      });
 */
export const DEFAULT_DAEMON_LIFECYCLE_OPTIONS: Pick<
	DaemonLifecycleOptions,
	'initialBackoffMs' | 'maxBackoffMs' | 'maxAttempts'
	| 'bannerTimeoutMs' | 'disposeGraceMs'
> = {
	initialBackoffMs: 1000,
	maxBackoffMs: 30_000,
	maxAttempts: 5,
	...DEFAULT_DAEMON_CLIENT_OPTIONS,
};

// ---------------------------------------------------------------------------
// implementation
// ---------------------------------------------------------------------------

export class DaemonLifecycle {

	private status: LifecycleStatus = { kind: 'idle' };
	private client: QvizDaemonClient | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	/** Monotonic per-spawn ID. Used to detect stale callbacks from a
	 *  client that we've already replaced. Never reset. */
	private spawnGeneration = 0;
	/** Consecutive failures since the last successful spawn. Drives the
	 *  exponential backoff and the maxAttempts cap. Reset to 0 on success. */
	private failuresSinceSuccess = 0;
	private disposed = false;
	/** Promise resolved when an in-flight `dispose()` completes. Concurrent
	 *  callers await the same teardown rather than racing. */
	private disposePromise: Promise<void> | null = null;

	private readonly statusHandlers: ((s: LifecycleStatus) => void)[] = [];
	/** Pending callers blocked in `getClient()` waiting for a transition
	 *  to 'ready' (or to a terminal error). */
	private readonly clientWaiters: Array<{
		resolve: (c: LifecycleClient) => void;
		reject: (e: Error) => void;
	}> = [];

	constructor(private readonly opts: DaemonLifecycleOptions) {
		// Validate options up front -- no fallback to hidden defaults.
		if (!Number.isFinite(opts.initialBackoffMs) || opts.initialBackoffMs < 0) {
			throw new Error('DaemonLifecycle: initialBackoffMs must be a non-negative finite number');
		}
		if (!Number.isFinite(opts.maxBackoffMs) || opts.maxBackoffMs < opts.initialBackoffMs) {
			throw new Error('DaemonLifecycle: maxBackoffMs must be >= initialBackoffMs');
		}
		if (!Number.isInteger(opts.maxAttempts) || opts.maxAttempts < 1) {
			throw new Error('DaemonLifecycle: maxAttempts must be a positive integer');
		}
	}

	// -----------------------------------------------------------------------
	// public surface
	// -----------------------------------------------------------------------

	getStatus(): LifecycleStatus { return this.status; }

	onStatusChange(handler: (s: LifecycleStatus) => void): () => void {
		this.statusHandlers.push(handler);
		return () => {
			const idx = this.statusHandlers.indexOf(handler);
			if (idx >= 0) { this.statusHandlers.splice(idx, 1); }
		};
	}

	/**
	 * Resolve with a healthy client. Triggers a spawn if currently idle.
	 * If already ready, resolves immediately. Otherwise queues the caller
	 * until the next 'ready' transition.
	 *
	 * Rejects with `DaemonUnavailableError` if the lifecycle is disposed
	 * or has reached the unavailable state.
	 */
	getClient(): Promise<LifecycleClient> {
		if (this.disposed) {
			return Promise.reject(new DaemonUnavailableError('lifecycle disposed'));
		}
		if (this.status.kind === 'unavailable') {
			return Promise.reject(new DaemonUnavailableError(this.status.error));
		}
		if (this.status.kind === 'ready' && this.client !== null) {
			return Promise.resolve(this.client);
		}
		// Either idle, starting, crashed (between crash and retry timer
		// fire), or respawning. Queue and trigger a spawn if idle.
		const pending = new Promise<LifecycleClient>((resolve, reject) => {
			this.clientWaiters.push({ resolve, reject });
		});
		if (this.status.kind === 'idle') {
			this.startSpawn();
		} else if (this.retryTimer !== null) {
			// A waiter is queued; ensure the retry timer keeps the event
			// loop alive long enough to resolve them. (It was unref'd at
			// schedule time in the no-waiter case.)
			if (typeof (this.retryTimer as { ref?: () => unknown }).ref === 'function') {
				(this.retryTimer as { ref: () => unknown }).ref();
			}
		}
		return pending;
	}

	/**
	 * Phase 8 Step D: skip the backoff window and start spawning now.
	 *
	 * Called when the user clicks "Retry connection" on the daemon-status
	 * banner. Behavior by current status:
	 *   - `ready`            → no-op; already up.
	 *   - `crashed` / `respawning` → cancel the pending retry timer and
	 *     start spawning immediately.
	 *   - `unavailable`      → reset to idle and start spawning. The
	 *     `unavailable` status normally means a non-recoverable error;
	 *     the user is explicitly overriding that judgment.
	 *   - `idle` / `starting` → no-op; nothing to retry.
	 *
	 * Returns `true` when an immediate spawn was initiated, `false`
	 * otherwise. Throws if the lifecycle has been disposed.
	 */
	requestImmediateRetry(): boolean {
		if (this.disposed) {
			throw new DaemonUnavailableError('lifecycle disposed');
		}
		const k = this.status.kind;
		if (k === 'ready' || k === 'idle' || k === 'starting') { return false; }
		this.cancelRetry();
		// Reset the failure counter so backoff starts fresh next crash;
		// the user has signaled they expect this attempt to succeed.
		this.failuresSinceSuccess = 0;
		this.startSpawn();
		return true;
	}

	/**
	 * Tear down. Cancels any pending respawn timer, disposes the live
	 * client (if any), rejects all queued `getClient()` waiters, and
	 * transitions to `unavailable`.
	 *
	 * Idempotent: subsequent calls await the same teardown promise.
	 */
	dispose(): Promise<void> {
		if (this.disposePromise !== null) { return this.disposePromise; }
		this.disposed = true;
		this.disposePromise = (async () => {
			this.cancelRetry();
			const reason = 'lifecycle disposed';
			// Megaudit MAJOR-29: dispose the live client BEFORE
			// transitioning to `unavailable`. The prior order
			// (transition → dispose) left a brief window where status
			// subscribers were told "gone" but the child process was
			// still alive for up to `disposeGraceMs` — risking
			// port/socket conflicts if a downstream consumer reacted
			// by spawning a fresh lifecycle.
			if (this.client) {
				const client = this.client;
				this.client = null;
				await client.dispose();
			}
			this.transition({ kind: 'unavailable', error: reason });
			const waiters = this.clientWaiters.splice(0, this.clientWaiters.length);
			const err = new DaemonUnavailableError(reason);
			for (const w of waiters) {
				w.reject(err);
			}
		})();
		return this.disposePromise;
	}

	// -----------------------------------------------------------------------
	// internals
	// -----------------------------------------------------------------------

	private transition(next: LifecycleStatus): void {
		this.status = next;
		// Snapshot so a handler that subscribes/unsubscribes during firing
		// doesn't cause an iteration bug. Handler exceptions PROPAGATE --
		// no try/catch fallback (CLAUDE.md "errors must be visible").
		const snapshot = this.statusHandlers.slice();
		for (const h of snapshot) {
			h(next);
		}
	}

	private startSpawn(): void {
		this.spawnGeneration += 1;
		const myGen = this.spawnGeneration;
		this.transition({ kind: 'starting', attemptNumber: this.failuresSinceSuccess + 1 });

		let client: QvizDaemonClient;
		try {
			client = new QvizDaemonClient(this.opts);
		} catch (e) {
			// `new QvizDaemonClient` may throw synchronously if `spawn`
			// rejects pre-event-loop (rare; usually it resolves async via
			// the 'error' event). Treat as a crash.
			this.onClientFailed(myGen, null, e instanceof Error ? e : new Error(String(e)));
			return;
		}
		this.client = client;

		// Subscribe BEFORE awaiting ready() so a crash during banner read
		// fires this handler.
		client.onClose(({ error, intended }) => {
			if (this.disposed && intended) {
				// Lifecycle-driven dispose -- do not respawn. The
				// transition has already been driven by `dispose()`.
				return;
			}
			if (myGen !== this.spawnGeneration || this.client !== client) {
				// Stale event from a discarded client.
				return;
			}
			this.onClientFailed(myGen, client, error);
		});

		client.ready().then(
			() => {
				if (this.disposed) { return; }
				if (myGen !== this.spawnGeneration || this.client !== client) {
					// We moved on; the spawn we awaited was already replaced.
					// Make sure the orphaned client is torn down so we don't
					// leak its child process or stream listeners.
					void client.dispose();
					return;
				}
				// Reset failure counter so the NEXT crash starts a fresh
				// backoff sequence. Do NOT reset spawnGeneration -- it's
				// the staleness key for in-flight callbacks.
				this.failuresSinceSuccess = 0;
				this.transition({ kind: 'ready' });
				this.flushWaiters(client);
			},
			(err: Error) => {
				if (myGen !== this.spawnGeneration || this.client !== client) {
					// Stale ready() rejection. The close handler already
					// drove the failure path.
					return;
				}
				this.onClientFailed(myGen, client, err);
			},
		);
	}

	private onClientFailed(
		gen: number, deadClient: QvizDaemonClient | null, error: Error,
	): void {
		if (this.disposed) { return; }
		if (gen !== this.spawnGeneration) { return; }
		// Bump generation FIRST so any in-flight ready() resolution / late
		// onClose callback for this generation is filtered out by the
		// staleness check at its own call site. After this point, even if
		// the dead client emits more events, we ignore them.
		this.spawnGeneration += 1;
		this.client = null;
		this.failuresSinceSuccess += 1;

		// Tear down the dead client so any lingering streams/listeners
		// release their resources and the underlying child is force-killed
		// if it hasn't already exited.
		if (deadClient !== null) {
			void deadClient.dispose();
		}

		const message = error.message || String(error);

		if (this.failuresSinceSuccess >= this.opts.maxAttempts) {
			const finalErr = `daemon failed after ${this.failuresSinceSuccess} attempts: ${message}`;
			this.transition({ kind: 'unavailable', error: finalErr });
			this.rejectWaiters(new DaemonUnavailableError(finalErr));
			return;
		}

		const retryInMs = this.computeBackoff(this.failuresSinceSuccess);
		this.transition({
			kind: 'crashed',
			error: message,
			retryInMs,
			attemptNumber: this.failuresSinceSuccess,
		});
		this.scheduleRetry(retryInMs, message);
	}

	private scheduleRetry(ms: number, lastError: string): void {
		this.cancelRetry();
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			if (this.disposed) { return; }
			this.transition({
				kind: 'respawning',
				attemptNumber: this.failuresSinceSuccess + 1,
				lastError,
			});
			this.startSpawn();
		}, ms);
		// Only unref the retry timer when there are NO waiters. With
		// waiters, the timer must keep the event loop alive long enough
		// to resolve them. (Step B megaudit Major: prior unconditional
		// unref let Node exit before waiters resolved.)
		if (
			this.clientWaiters.length === 0
			&& typeof this.retryTimer.unref === 'function'
		) {
			this.retryTimer.unref();
		}
	}

	private cancelRetry(): void {
		if (this.retryTimer !== null) {
			clearTimeout(this.retryTimer);
			this.retryTimer = null;
		}
	}

	private computeBackoff(attempt: number): number {
		// attempt is 1-based. backoff = initial * 2^(attempt-1), capped.
		const raw = this.opts.initialBackoffMs * Math.pow(2, Math.max(0, attempt - 1));
		return Math.min(raw, this.opts.maxBackoffMs);
	}

	private flushWaiters(client: LifecycleClient): void {
		const waiters = this.clientWaiters.splice(0, this.clientWaiters.length);
		for (const w of waiters) {
			w.resolve(client);
		}
	}

	private rejectWaiters(err: Error): void {
		const waiters = this.clientWaiters.splice(0, this.clientWaiters.length);
		for (const w of waiters) {
			w.reject(err);
		}
	}
}
