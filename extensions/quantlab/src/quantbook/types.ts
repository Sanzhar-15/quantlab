/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V1 (2026-05-22) -- TypeScript declarations mirroring the
 * `ql-bindings-node` napi-rs surface (Rust crate at
 * `quantlab-quantbook/quantbook-engine/crates/ql-bindings-node`).
 *
 * **Source of truth**: the Rust crate. If you edit this file, also
 * update `crates/ql-bindings-node/src/lib.rs` (and vice versa). V2
 * will add a generator (`@napi-rs/cli typegen`) to keep them in sync
 * automatically.
 *
 * **V1 surface**: a single class `CollabSession` exposing the minimum
 * round-trip methods. See the Rust crate's module docs for V1 surface
 * rationale + V2 deferred list.
 */

/**
 * A peer-to-peer collaboration session. Wraps the engine's
 * `ql_collab::CollabSession`.
 *
 * **Failure modes** (constructors throw JS `Error`):
 * - `peerId == 0n` -- PeerId reserves 0 (Loro sentinel)
 * - `peerId < 0n` -- PeerId is u64-domain
 * - `peerId` exceeds u64 -- lossy BigInt conversion
 *
 * Method failures (engine-level errors, e.g., merge of malformed
 * bytes) surface as JS `Error` exceptions with the engine's error
 * message string.
 */
export interface CollabSessionInstance {
	/**
	 * V1 convenience: append a `PutValue` op with a numeric value.
	 * Full Op enum binding is V2 work; V1 exposes this single variant
	 * because it's the minimum that demonstrates the round-trip.
	 */
	appendPutValue(sheet: number, row: number, col: number, value: number): void;

	/** Full snapshot export. Use for initial sync / handshake. */
	exportBytes(): Uint8Array;

	/**
	 * Merge a snapshot (or delta) from another peer. Returns the
	 * session's `opCount` AFTER the merge (NOT the number of newly
	 * merged ops -- duplicates are deduped by Loro but the return
	 * value is the post-merge total).
	 *
	 * **V1 audit closure (Codex M2, 2026-05-22)**: the original
	 * docstring claimed "count of ops actually merged" implying a
	 * delta. Verified empirically by calling `mergeBytes` twice with
	 * the same snapshot: both calls return the same `opCount` value.
	 * V2 may add a `mergeBytesDelta` companion that returns just the
	 * newly merged count, once the use case (e.g., "warn if peer
	 * sent us X new ops") materializes.
	 */
	mergeBytes(bytes: Uint8Array): number;

	/** Local op log length (visible LoroList). */
	opCount(): number;

	/**
	 * V2 V4 V1 step 2 helper: count of ops added since the last
	 * successful flush. Uses VV math (monotonic under undo). Sibling
	 * invariant: `pendingOpCount() > 0` iff `hasPendingFlush() === true`.
	 *
	 * V1 has no Transport binding, so this returns the count vs the
	 * empty baseline (same as `opCount()` for a never-flushed session).
	 * V2 makes this interesting once Transport surface is bound.
	 */
	pendingOpCount(): number;

	/** V2 V3 step 3 helper: `true` when local ops haven't been flushed. */
	hasPendingFlush(): boolean;

	/** Peer ID of this session, as a BigInt (u64-domain). */
	peerId(): bigint;

	// =====================================================================
	// Phase 5.7 V2.1 (2026-05-22) -- Transport surface (sync portion)
	// =====================================================================

	/**
	 * Attach a Transport to this session. The `transport` instance is
	 * CONSUMED -- subsequent calls with the same wrapper throw.
	 *
	 * Resets the session's per-transport VV baseline (Phase 5.5 V2 V3
	 * step 1 contract): the next flush sends from empty VV, delivering
	 * all local ops including any appended while no transport was
	 * attached. Loro's CRDT op log IS the implicit offline queue.
	 *
	 * @throws Error if `transport` has already been consumed.
	 */
	attachTransport(transport: TransportInstance): void;

	/**
	 * Detach the currently-attached transport. Returns `true` if one
	 * was attached (now released, its background tasks dropped),
	 * `false` if there was nothing to detach.
	 *
	 * V2.1 drops the returned `Box<dyn Transport>` Rust-side -- JS
	 * does not receive the prior transport.
	 */
	detachTransport(): boolean;

	/** `true` iff a transport is currently attached. */
	hasTransport(): boolean;

	/**
	 * Full-snapshot flush to the attached transport. Returns `true` if
	 * bytes were sent, `false` if no transport is attached.
	 *
	 * **Use the upcoming `flushDeltaToTransport` instead in production**
	 * once V2.2 ships -- delta flushes are O(per-op delta) vs O(full
	 * state).
	 *
	 * @throws Error if the transport's `send` returns an error.
	 */
	flushToTransport(): boolean;

	/**
	 * Drain inbound BLOBS from the attached transport (single-pass).
	 * Returns the count of BLOBS drained (NOT the count of ops),
	 * capped by the engine's default poll limit (`DEFAULT_POLL_REMOTE_LIMIT
	 * = 64`). Each blob is one snapshot/delta that may contain many ops;
	 * to count ops, compare `opCount()` before vs after.
	 *
	 * `0` if no transport is attached or no bytes were queued.
	 *
	 * **V2.1 audit closure (Codex MEDIUM-1, 2026-05-22)**: the prior
	 * docstring said "count of ops merged" which contradicted the
	 * engine's semantics (`poll_remote_with_limit` returns `merged <=
	 * max_blobs`). Mocha test "three-mutation chain across LoopbackPair"
	 * empirically discovered this and now pins the blob-count contract.
	 *
	 * @throws Error if the transport's `try_recv` or the merge step
	 *               returns an error.
	 */
	pollRemote(): number;

	// =====================================================================
	// Phase 5.7 V2.2 (2026-05-22) -- full sync Transport surface
	// =====================================================================

	/**
	 * Delta flush to the attached transport. Sends ONLY the ops added
	 * since the last successful flush. Returns `true` if bytes were
	 * actually sent.
	 *
	 * **Production default**. Prefer this over `flushToTransport`
	 * (full-snapshot) which is O(full state). Delta flushes are
	 * O(per-op delta).
	 *
	 * Idempotency: no state changed since last flush -> returns
	 * `false` without invoking `transport.send` (closes the V2 V2
	 * audit echo-loop concern).
	 *
	 * Per V2 V3 step 1: `attachTransport` resets the per-transport
	 * VV baseline, so the next `flushDeltaToTransport` after an attach
	 * sends from empty -- delivering ALL ops including any appended
	 * while offline (Loro's op log IS the implicit offline queue).
	 *
	 * @throws Error if the transport's `send` returns an error.
	 */
	flushDeltaToTransport(): boolean;

	/**
	 * Like `pollRemote` but with an explicit per-call cap on the
	 * number of blobs to drain. Returns the blob count, `<= limit`.
	 *
	 * Returned-count semantics:
	 * - `limit === 0` -> always returns 0 (no-op even if blobs queued).
	 * - Returned count `=== limit` -> more blobs may be queued; call again.
	 * - Returned count `< limit` -> queue drained.
	 *
	 * @param limit Non-negative integer in `[0, u32::MAX]`. NaN /
	 *              Infinity / fractional / negative throw.
	 *
	 * @throws Error if `limit` is invalid OR transport `try_recv` errors.
	 */
	pollRemoteWithLimit(limit: number): number;

	/**
	 * The attached transport's most recent error message, or `null` if
	 * no transport is attached OR the transport reports no error.
	 *
	 * **Use case**: after a mutator throws `Error("transport closed")`
	 * (or similar), call this to distinguish underlying causes (peer
	 * reset vs auth rejection vs capacity exceeded for V2.3+
	 * WebSocketTransport) and pick the reconnect strategy.
	 *
	 * **V2.2 audit-deferred caveat (Opus MEDIUM-3)**: error strings are
	 * lossy `Display` projections of the underlying enum. IDE callers
	 * today must substring-match to distinguish categories. V2.3+ will
	 * add structured discrimination via napi `Error.code`.
	 */
	transportLastError(): string | null;

	/**
	 * Set the auto-flush policy. Returns the prior policy as a string.
	 *
	 * Accepted: `'disabled'` (default) or `'onAppend'`. Other strings
	 * throw with a precise error.
	 *
	 * `'onAppend'` semantics (V2 V2 + V2 V3 steps 1+2): every public
	 * mutator auto-fires a delta flush after the mutation. Idempotency
	 * short-circuits no-op state changes; `pollRemote*` fires once
	 * after the batch (not per-blob).
	 *
	 * @throws Error on unknown policy string.
	 */
	setAutoFlushPolicy(policy: AutoFlushPolicy): AutoFlushPolicy;

	/**
	 * Read the current auto-flush policy. `'disabled'` is the default.
	 *
	 * **V2.2 audit closure (Opus HIGH-1, 2026-05-22)**: throws if the
	 * engine reports a variant unknown to this binding (forward-compat
	 * skew -- engine ships a new variant ahead of the binding crate
	 * being upgraded). Prior version returned `'unknown'` as a silent
	 * sentinel; per CLAUDE.md no-fallback rule that was wrong (JS
	 * `policy === 'onAppend'` would silently fall through to the
	 * `disabled` branch). Throwing surfaces the skew loudly and forces
	 * a binding upgrade.
	 *
	 * @throws Error if the engine variant is unknown to this binding.
	 */
	autoFlushPolicy(): AutoFlushPolicy;

	// =====================================================================
	// Phase 5.7 V2.4 (2026-05-22) -- async Transport surface, REINTRODUCED
	// =====================================================================

	/**
	 * Async flush-pending. Waits for the attached transport's writer
	 * task to drain (level-1 local ack per V2 V4 V1 Tier K1).
	 *
	 * **V2.4 reintroduction**: V2.3 ship initially included this but
	 * V2.3 audit (Codex FAIL + Opus 2H) found two convergent HIGH
	 * hazards (Rust UB via napi `&mut self` async re-entry + tokio
	 * runtime starvation). V2.4 closure refactored the engine's
	 * `CollabSession` napi class to hold `Arc<parking_lot::Mutex<...>>`
	 * (all methods now `&self`; spawn_blocking pattern for async). The
	 * UB hazard is structurally impossible now (no `&mut self` on the
	 * binding). The runtime starvation hazard is closed by
	 * `spawn_blocking` (Condvar wait runs on a dedicated blocking
	 * thread, not a tokio worker).
	 *
	 * Resolves when:
	 * - writer has completed `send` for every queued blob, OR
	 * - transport has been detached / dropped / errored.
	 *
	 * **No-op on no transport**: returns resolved Promise (NOT
	 * rejection).
	 *
	 * @throws Error if the transport reports an error, or if the
	 *               spawn_blocking task panics.
	 */
	flushPendingToTransport(): Promise<void>;
}

/**
 * Auto-flush policy string union. Mirrors `ql_collab::AutoFlushPolicy`
 * (Rust enum), bound as JS strings via the napi
 * `setAutoFlushPolicy` / `autoFlushPolicy` methods.
 *
 * - `'disabled'`: explicit-drive (V2 V1 behavior). Caller invokes
 *   `flushDeltaToTransport` + `pollRemote*` on a tick.
 * - `'onAppend'`: every mutator + `pollRemote*` auto-fires a delta
 *   flush.
 *
 * The engine's underlying enum is `#[non_exhaustive]`. Future variants
 * require this union to be widened AND the napi binding's
 * `parse_auto_flush_policy` + `auto_flush_policy_to_string` helpers to
 * be updated. Until both layers are upgraded, `autoFlushPolicy()`
 * throws on the new variant (V2.2 closure of Opus HIGH-1: no
 * silent-sentinel fall-through).
 */
export type AutoFlushPolicy = 'disabled' | 'onAppend';

export interface CollabSessionConstructor {
	new(peerId: bigint): CollabSessionInstance;

	/** Reconstruct a session from a previously-exported snapshot. */
	fromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSessionInstance;
}

// =====================================================================
// Phase 5.7 V2.1 (2026-05-22) -- Transport binding type declarations
// =====================================================================

/**
 * Opaque wrapper for a `Box<dyn ql_collab::Transport + Send>`.
 *
 * **Single-use semantics**: an instance owns its boxed trait object.
 * `CollabSession.attachTransport(t)` MOVES the box out, leaving the
 * wrapper consumed. After consumption, `isAttachable()` returns
 * `false` and subsequent `attachTransport` calls with the same
 * wrapper throw.
 *
 * Instances are obtained from factory classes (V2.1: `LoopbackPair`;
 * V2.3+: `Transport.websocketConnect(url)`).
 */
export interface TransportInstance {
	/**
	 * `true` while this wrapper still owns its inner transport.
	 * `false` after passing to `attachTransport` (or any other
	 * future API that consumes the wrapper).
	 *
	 * Useful for branching without exception handling:
	 * ```ts
	 * if (transport.isAttachable()) {
	 *   session.attachTransport(transport);
	 * }
	 * ```
	 */
	isAttachable(): boolean;
}

/**
 * Two-ended in-process Transport pair (`LoopbackTransport`).
 *
 * **V2.1 entry point** for obtaining paired Transport instances. The
 * pair's two ends share an in-process queue: bytes sent on end A
 * arrive at end B's `try_recv` and vice versa.
 *
 * Each end can be `take`-n once. Calling `takeA` (or `takeB`) a
 * second time on the same pair throws. The two takes are
 * independent (taking A doesn't affect taking B).
 */
export interface LoopbackPairInstance {
	/**
	 * Take ownership of end A. Each `LoopbackPair` instance can have
	 * `takeA` called once.
	 * @throws Error on the second call.
	 */
	takeA(): TransportInstance;

	/**
	 * Take ownership of end B. Each `LoopbackPair` instance can have
	 * `takeB` called once.
	 * @throws Error on the second call.
	 */
	takeB(): TransportInstance;
}

export interface LoopbackPairConstructor {
	new(): LoopbackPairInstance;
}

/**
 * Top-level exports from the native `.dylib` / `.so` / `.dll`. Loaded
 * via {@link loadQuantbookEngine} in `./loader`.
 */
export interface QuantbookNativeModule {
	/** Smoke method exposing the binding crate's own version. */
	version(): string;

	/** Session class -- see {@link CollabSessionInstance}. */
	readonly CollabSession: CollabSessionConstructor;

	/**
	 * V2.1: opaque Transport wrapper. JS-side this is mostly used
	 * as a parameter type to `CollabSession.attachTransport`.
	 * The constructor is NOT directly exposed -- obtain instances
	 * via factories like `LoopbackPair`.
	 *
	 * **V2.3 (2026-05-22)**: added `websocketConnect(url)` static
	 * async factory that resolves with a Transport wrapping a
	 * `WebSocketTransport`. See `flushPendingToTransport` for the
	 * matching async drain helper.
	 */
	readonly Transport: {
		prototype: TransportInstance;
		/**
		 * Async factory: connect to a WebSocket peer and return a
		 * Transport wrapping the live connection.
		 *
		 * @param url `ws://host:port` URL. No TLS in V2.3.
		 * @returns Promise resolving with the Transport (single-use;
		 *          pass to `attachTransport` once).
		 * @throws  Error with WebSocket failure category in the
		 *          message (`WebSocket connection failed`,
		 *          `WebSocket handshake failed`, `invalid WebSocket URL`).
		 */
		websocketConnect(url: string): Promise<TransportInstance>;
	};

	/**
	 * V2.1: LoopbackPair class -- factory for paired in-process
	 * Transport ends.
	 */
	readonly LoopbackPair: LoopbackPairConstructor;
}
