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
	 * Merge a snapshot (or delta) from another peer. Returns the count
	 * of ops actually merged (Loro dedupes by causal history).
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
}

export interface CollabSessionConstructor {
	new(peerId: bigint): CollabSessionInstance;

	/** Reconstruct a session from a previously-exported snapshot. */
	fromSnapshot(peerId: bigint, bytes: Uint8Array): CollabSessionInstance;
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
}
