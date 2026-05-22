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
}

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
	 */
	readonly Transport: { prototype: TransportInstance };

	/**
	 * V2.1: LoopbackPair class -- factory for paired in-process
	 * Transport ends.
	 */
	readonly LoopbackPair: LoopbackPairConstructor;
}
