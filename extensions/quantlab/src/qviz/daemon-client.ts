/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * TypeScript client for the qviz Python query daemon.
 *
 * Spawns `python -m qviz.daemon` as a long-lived subprocess and exchanges
 * length-prefixed framed messages over stdio. One client per workspace.
 *
 * Wire format (mirrors python/qviz/ipc.py exactly):
 *
 *   +-----------+-----------+--------+----------+
 *   | uint32 LE | uint8     | uint8  | bytes... |
 *   | length    | type tag  | resv.  | payload  |
 *   +-----------+-----------+--------+----------+
 *
 *   tag 0x01  -> JSON UTF-8
 *   tag 0x02  -> Apache Arrow IPC stream
 *
 * Request shape: JSON `{ id: number, op: string, ...op-specific }`.
 * Response shape: JSON `{ id, ok, encoding: 'json'|'arrow', data, elapsed_ms, error? }`.
 * For ops with `encoding === 'arrow'`, the daemon writes a follow-up Arrow
 * frame on the same channel immediately after the JSON response. The client
 * pairs them by request order (the daemon is single-threaded; replies are
 * in-order).
 *
 * Lifecycle:
 *   const client = new QvizDaemonClient({ workspaceRoot, pythonPath });
 *   const banner = await client.ready();
 *   const { data } = await client.schema('data/x.parquet');
 *   await client.dispose();
 *
 * Errors:
 *   - daemon process exit while requests are pending -> all pending reject
 *     with DaemonClosedError.
 *   - protocol violation (truncated frame, unknown tag, etc.) -> all
 *     pending reject with DaemonProtocolError, client transitions to fatal.
 *   - daemon error response -> the corresponding promise rejects with
 *     DaemonOpError carrying the daemon's `error` string.
 *   - ready() not satisfied within bannerTimeoutMs -> rejects with
 *     DaemonProtocolError; subsequent ops also reject.
 *
 * Cancellation: not supported in v1 (the daemon protocol has no cancel op).
 * Per-request timeout is the daemon's responsibility; clients can also
 * race against an external AbortSignal for UI-level dismissal.
 */

import { ChildProcessWithoutNullStreams, spawn } from 'child_process';
import { Readable, Writable } from 'stream';

import type { QvizSpec } from './spec';

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

export class DaemonClosedError extends Error {
	constructor(message: string) { super(message); this.name = 'DaemonClosedError'; }
}

export class DaemonProtocolError extends Error {
	constructor(message: string) { super(message); this.name = 'DaemonProtocolError'; }
}

/** Megaudit MAJOR-34: structured kind from the daemon's `error_kind`
 *  response field. Used by the provider to map to the protocol's
 *  typed `errorKind` without parsing the message string.
 *
 *  Megaudit F3 (2026-05-13): `'protocol'` added so daemon-side protocol
 *  violations (non-dict frames, unknown op, etc. -- see
 *  `python/qviz/daemon.py:906,914`) round-trip with the correct kind
 *  instead of silently downgrading to `'compile'`. */
export type DaemonErrorKind =
	| 'compile'
	| 'security'
	| 'timeout'
	| 'memory'
	| 'internal'
	| 'protocol';

/** Source of truth for the kind set; exported for the cross-side
 *  contract test that greps daemon.py to confirm the Python side hasn't
 *  drifted. */
export const DAEMON_ERROR_KINDS: ReadonlySet<DaemonErrorKind> = new Set([
	'compile', 'security', 'timeout', 'memory', 'internal', 'protocol',
]);

/** Megaudit F3 (2026-05-13): strict decoder. Per CLAUDE.md "no
 *  fallbacks" the previous default-to-`'compile'` silently masked
 *  classification bugs; we now refuse unknown/missing kinds with
 *  `DaemonProtocolError`. Callers MUST catch in the same pattern they
 *  catch `requireFiniteElapsed` (push head back, failPending). */
export function decodeDaemonErrorKind(raw: unknown, op: string): DaemonErrorKind {
	if (typeof raw === 'string' && DAEMON_ERROR_KINDS.has(raw as DaemonErrorKind)) {
		return raw as DaemonErrorKind;
	}
	throw new DaemonProtocolError(
		`response for op '${op}' has invalid error_kind=${JSON.stringify(raw)}; `
		+ `expected one of ${[...DAEMON_ERROR_KINDS].sort().join(', ')}`,
	);
}

export class DaemonOpError extends Error {
	readonly elapsedMs: number;
	readonly errorKind: DaemonErrorKind;
	// Megaudit F3 (2026-05-13): the `errorKind` parameter was previously
	// defaulted to `'compile'`. That default was the same shape of
	// silent classification fallback `decodeDaemonErrorKind` now refuses
	// at the wire; the constructor must match. Callers MUST pass the
	// kind explicitly.
	constructor(message: string, elapsedMs: number, errorKind: DaemonErrorKind) {
		super(message);
		this.name = 'DaemonOpError';
		this.elapsedMs = elapsedMs;
		this.errorKind = errorKind;
	}
}

// ---------------------------------------------------------------------------
// wire types
// ---------------------------------------------------------------------------

const FRAME_JSON = 0x01;
const FRAME_ARROW_IPC = 0x02;
const HEADER_SIZE = 6;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Documented defaults for client tunables. Callers spread this
 *  explicitly at the constructor call site so the configuration is
 *  visible in source review. */
export const DEFAULT_DAEMON_CLIENT_OPTIONS: {
	readonly bannerTimeoutMs: number;
	readonly disposeGraceMs: number;
} = {
	bannerTimeoutMs: 10_000,
	disposeGraceMs: 2_000,
};

export interface DaemonBanner {
	readonly daemon: 'qviz';
	readonly version: number;
	readonly ops: readonly string[];
}

export interface JsonResponse<TData> {
	readonly data: TData;
	readonly elapsedMs: number;
	readonly cached?: boolean;
}

export interface ArrowResponse<TMeta> {
	readonly meta: TMeta;
	readonly arrow: Uint8Array;
	readonly elapsedMs: number;
	/** REQUIRED. The Step C megaudit removed the `cached ?? false`
	 *  fallback in `callJsonOrArrow`; `readCached` throws if the daemon
	 *  doesn't include the field. Type now reflects the runtime
	 *  invariant. */
	readonly cached: boolean;
}

export interface SchemaColumn {
	readonly name: string;
	readonly dtype: string;
	readonly nullable: boolean;
}

export interface SchemaData {
	readonly uri: string;
	readonly schema_hash: string;
	readonly mtime_ns: number;
	readonly row_count: number | null;
	readonly columns: readonly SchemaColumn[];
}

export interface PreviewMeta {
	readonly n: number;
	readonly bytes?: number;
	readonly columns?: readonly string[];
}

export interface AggregateMeta {
	readonly n: number;
	readonly bytes: number;
	readonly columns: readonly string[];
	/** Megaudit G5 (2026-05-13): compile-time precision-loss warnings
	 *  (e.g. `sum(BIGINT)` cast to DOUBLE losing ones-place past
	 *  2^53). Present only when non-empty; consumers must treat
	 *  `undefined` and `[]` equivalently. The provider relays this
	 *  to the webview's diagnostics readout so users see the loss
	 *  rather than silently mis-trusting the chart values. */
	readonly warnings?: readonly string[];
	/** Front 2 (2026-05-14): per-transform schema-snapshot attribution.
	 *  Wire shape uses camelCase already (the daemon's
	 *  `_attribution_to_wire` does the snake→camel transform server-side).
	 *  Absent on pre-Front-2 daemons. */
	readonly attribution?: readonly {
		readonly index: number;
		readonly kind: string;
		readonly produces: readonly string[];
		readonly drops: readonly string[];
		readonly availableAfter: readonly string[];
	}[];
}

export interface DecimateMeta {
	readonly n_input?: number;
	readonly n_output?: number;
	readonly bytes?: number;
	readonly carry_cols?: readonly string[];
}

/** Daemon capability descriptor returned by `op_capabilities`. The
 *  shape matches the snake-case JSON the daemon emits; the
 *  provider transforms it into the camelCase `DaemonCapabilities`
 *  shape required by the protocol's `init.capabilities` field. */
export interface DaemonCapabilitiesData {
	readonly daemon_version: number;
	readonly transform_kinds: readonly string[];
	readonly unsupported: readonly string[];
	readonly chart_families: readonly string[];
	/** Phase 6 (6.A.4): per-op feature flags for the inspector. Absent on
	 *  pre-Phase-6 daemons, in which case the inspector UI stays disabled. */
	readonly inspector?: {
		readonly preview_offset: boolean;
		readonly column_stats: boolean;
		readonly aggregate_filters: boolean;
	};
	/** Front 2 (2026-05-14): when true, the daemon emits per-transform
	 *  schema-snapshot attribution in `op_aggregate` responses. The
	 *  capabilitiesTransform translates this to camelCase
	 *  `transformAttributionV1` for the webview-side capabilities bag. */
	readonly transform_attribution_v1?: boolean;
}

/** Phase 6 (6.A.2): the column-stats response shape. The inspector's
 *  filter widget picks its UI based on `kind` and `cardinality_is_exact`. */
export interface ColumnStatsData {
	readonly kind: 'numeric' | 'temporal' | 'string' | 'bool' | 'nominal';
	readonly cardinality: number;
	readonly cardinality_is_exact: boolean;
	readonly null_count: number;
	readonly total: number;
	/** Set only when kind is numeric/temporal AND non-null rows exist.
	 *  Temporal min/max are ISO strings; numeric are bare numbers. */
	readonly min?: number | string;
	readonly max?: number | string;
	/** Set only when cardinality_is_exact === true. */
	readonly distinct?: readonly unknown[];
	/** True when the response came from the schema_cache. */
	readonly cached?: boolean;
}

/** Phase 6 (6.A.3): inspector filters are FilterTransform objects, but the
 *  daemon-client doesn't import the full transform discriminated union to
 *  keep the file dependency-light. This narrower type captures only what
 *  this layer needs to encode JSON. The webview's validator ensures the
 *  payload conforms to the full FilterTransform shape before sending. */
export interface InspectorFilterDTO {
	readonly kind: 'filter';
	readonly column: string;
	readonly op: string;
	readonly value: unknown;
}

// ---------------------------------------------------------------------------
// options
// ---------------------------------------------------------------------------

export interface QvizDaemonClientOptions {
	/** Absolute path to the workspace folder. Daemon resolves all
	 *  dataset URIs relative to this. */
	readonly workspaceRoot: string;
	/** Path to the Python interpreter (typically the project venv). */
	readonly pythonPath: string;
	/** Extra entries prepended to PYTHONPATH so `qviz.daemon` resolves.
	 *  Required unless the qviz package is on the interpreter's site-packages. */
	readonly pythonPathPrefix?: readonly string[];
	/** Override the module name; defaults to 'qviz.daemon'. */
	readonly module?: string;
	/** Optional environment overrides merged on TOP of process.env, but
	 *  BENEATH the daemon-required env (QUANTLAB_WORKSPACE_ROOT, PYTHONPATH).
	 *  Audit-fix AF7: caller cannot override security-sensitive workspace root. */
	readonly env?: Readonly<Record<string, string>>;
	/** How long to wait for the daemon's banner before rejecting `ready()`.
	 *  Spread `DEFAULT_DAEMON_CLIENT_OPTIONS` to use the documented
	 *  default. Audit-fix AF9 + megaudit-cycle-2 (no-fallback). */
	readonly bannerTimeoutMs: number;
	/** How long `dispose()` waits for graceful exit before SIGKILL.
	 *  Spread `DEFAULT_DAEMON_CLIENT_OPTIONS` to use the documented default. */
	readonly disposeGraceMs: number;
}

// ---------------------------------------------------------------------------
// pending-request bookkeeping
// ---------------------------------------------------------------------------

interface PendingRequest {
	readonly id: number;
	readonly op: string;
	readonly expectsArrow: boolean;
	readonly resolve: (resp: { json: unknown; arrow?: Uint8Array }) => void;
	readonly reject: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// chunk queue (audit-fix AF10: O(n) parser, no buffer copy on every chunk)
// ---------------------------------------------------------------------------

/**
 * A linked list of incoming Buffer chunks. Frame parsing peeks at headers
 * by reading across chunk boundaries without merging the whole buffer. We
 * only materialize a contiguous Uint8Array when emitting a frame's payload.
 * This is O(N) for N total bytes regardless of chunk size, vs the prior
 * concat-on-every-chunk approach which was O(N^2).
 *
 * Exported for unit testing (audit-fix AF33). Internal use only otherwise.
 */
export class ChunkQueue {
	private chunks: Buffer[] = [];
	private byteLength = 0;

	get size(): number { return this.byteLength; }

	push(chunk: Buffer): void {
		this.chunks.push(chunk);
		this.byteLength += chunk.length;
	}

	/** Read N bytes starting at `offset`, copying into a fresh Uint8Array. */
	slice(offset: number, length: number): Uint8Array {
		if (offset + length > this.byteLength) {
			throw new Error(`slice out of range: ${offset}+${length} > ${this.byteLength}`);
		}
		const out = new Uint8Array(length);
		let written = 0;
		let skipped = 0;
		for (const c of this.chunks) {
			if (skipped + c.length <= offset) {
				skipped += c.length;
				continue;
			}
			const start = Math.max(0, offset - skipped);
			const take = Math.min(c.length - start, length - written);
			out.set(c.subarray(start, start + take), written);
			written += take;
			if (written >= length) { break; }
			skipped += c.length;
		}
		return out;
	}

	/** Read a single byte without copying. */
	readUint8(offset: number): number {
		if (offset >= this.byteLength) {
			throw new Error(`readUint8 out of range: ${offset} >= ${this.byteLength}`);
		}
		let skipped = 0;
		for (const c of this.chunks) {
			if (skipped + c.length > offset) {
				return c[offset - skipped];
			}
			skipped += c.length;
		}
		throw new Error('unreachable');
	}

	/** Read a uint32 little-endian, possibly crossing a chunk boundary.
	 *
	 *  Megaudit CRITICAL-1: the prior body had an operator-precedence
	 *  bug. `>>>` binds tighter than `|`, so `... | (s[3] << 24) >>> 0`
	 *  only coerced the top byte (which alone is in the negative
	 *  domain after `<<24` for top-bit-set values) instead of the
	 *  combined OR. Lengths in [0x80000000, 0xFFFFFFFF] produced
	 *  negative numbers, the MAX_FRAME_BYTES guard then accepted them,
	 *  and `HEADER_SIZE + length` underflowed → silent protocol desync.
	 *  Parentheses around the OR-chain are mandatory. */
	readUint32LE(offset: number): number {
		const slice = this.slice(offset, 4);
		return (slice[0] | (slice[1] << 8) | (slice[2] << 16) | (slice[3] << 24)) >>> 0;
	}

	/** Drop the first n bytes from the queue. */
	consume(n: number): void {
		if (n > this.byteLength) {
			throw new Error(`consume more than available: ${n} > ${this.byteLength}`);
		}
		this.byteLength -= n;
		while (n > 0 && this.chunks.length > 0) {
			const c = this.chunks[0];
			if (c.length <= n) {
				this.chunks.shift();
				n -= c.length;
			} else {
				this.chunks[0] = c.subarray(n) as Buffer;
				n = 0;
			}
		}
	}

	clear(): void {
		this.chunks.length = 0;
		this.byteLength = 0;
	}
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

export class QvizDaemonClient {
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly stdin: Writable;
	private readonly stdout: Readable;
	private readonly bannerPromise: Promise<DaemonBanner>;
	private readonly stderrLog: string[] = [];
	private readonly disposeGraceMs: number;

	private readonly pending = new Map<number, PendingRequest>();
	private readonly orderedQueue: PendingRequest[] = [];

	private nextId = 1;
	private buffer: ChunkQueue = new ChunkQueue();
	private closed = false;
	private fatal: Error | null = null;
	private intendedClose = false;
	/** Captured close info so `onClose()` callers that subscribe AFTER
	 *  close has already fired still receive the event (Step B megaudit
	 *  Major: late-subscriber close handlers). */
	private closeInfo: { error: Error; intended: boolean } | null = null;
	private readonly closeHandlers: ((info: { error: Error; intended: boolean }) => void)[] = [];
	/** Set when we've read the JSON head of an arrow-encoded response and
	 *  are waiting for the binary follow-up frame. */
	private awaitingArrowFor: PendingRequest | null = null;
	private lastJsonForArrow: unknown = null;

	/** Backpressure resolution: callers pile up here until 'drain' fires. */
	private drainWaiters: (() => void)[] = [];

	/** Megaudit CRITICAL-9: serialize stdin writes through a Promise
	 *  chain so request bytes hit the wire in FIFO order even when one
	 *  call is parked on `drain`. Without this, a backpressured A and
	 *  an unblocked B can race past A, the daemon processes B first,
	 *  and the orderedQueue (which has A at the head) mismatches the
	 *  daemon's response order → fatal protocol desync. */
	private writeChain: Promise<void> = Promise.resolve();

	private bannerTimer: NodeJS.Timeout | null = null;

	constructor(opts: QvizDaemonClientOptions) {
		if (!Number.isFinite(opts.disposeGraceMs) || opts.disposeGraceMs < 0) {
			throw new Error('QvizDaemonClient: disposeGraceMs must be a non-negative finite number');
		}
		if (!Number.isFinite(opts.bannerTimeoutMs) || opts.bannerTimeoutMs <= 0) {
			throw new Error('QvizDaemonClient: bannerTimeoutMs must be a positive finite number');
		}
		this.disposeGraceMs = opts.disposeGraceMs;

		// Audit-fix AF7: caller env merged FIRST, then daemon-required env
		// is set, so QUANTLAB_WORKSPACE_ROOT and PYTHONPATH cannot be
		// overridden by user-supplied env values.
		//
		// Megaudit M-6 defense-in-depth: scrub dynamic-loader / Python-
		// startup env vars. LD_PRELOAD, DYLD_INSERT_LIBRARIES, PYTHONSTARTUP,
		// PYTHONHOME, etc. can cause the child to load attacker-controlled
		// code on launch.
		//
		// Megaudit-2 C2: scrub MUST happen AFTER opts.env merge -- the
		// previous order let a misbehaving caller reintroduce the
		// scrubbed vars via opts.env. Now: merge first, scrub last,
		// then set the daemon-required vars (which overrides any
		// caller-supplied PYTHONPATH).
		// Megaudit-2 M4: PYTHONPATH added to the scrub set because the
		// prefix-prepend pattern still left user-supplied PYTHONPATH
		// reachable for transitive imports.
		const SCRUBBED_ENV_VARS = [
			'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'LD_DEBUG', 'LD_BIND_NOW',
			'DYLD_INSERT_LIBRARIES', 'DYLD_LIBRARY_PATH',
			'DYLD_FRAMEWORK_PATH', 'DYLD_FALLBACK_LIBRARY_PATH',
			'DYLD_PRINT_STATISTICS', 'DYLD_PRINT_LIBRARIES',
			'PYTHONSTARTUP', 'PYTHONHOME', 'PYTHONPATH',
		];
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (opts.env) {
			for (const k of Object.keys(opts.env)) { env[k] = opts.env[k]; }
		}
		for (const v of SCRUBBED_ENV_VARS) {
			delete env[v];
		}
		// Defense-in-depth: disable user site-packages so a malicious
		// `~/.local/lib/pythonX.Y/site-packages/qviz/` cannot shadow
		// the bundled qviz module.
		env.PYTHONNOUSERSITE = '1';
		env.QUANTLAB_WORKSPACE_ROOT = opts.workspaceRoot;
		if (opts.pythonPathPrefix && opts.pythonPathPrefix.length > 0) {
			const sep = process.platform === 'win32' ? ';' : ':';
			// PYTHONPATH was scrubbed; set it to the prefix only.
			env.PYTHONPATH = opts.pythonPathPrefix.join(sep);
		}

		this.child = spawn(
			opts.pythonPath,
			['-u', '-m', opts.module ?? 'qviz.daemon'],
			{ env, stdio: ['pipe', 'pipe', 'pipe'] }
		);
		this.stdin = this.child.stdin;
		this.stdout = this.child.stdout;

		this.child.stderr.setEncoding('utf8');
		this.child.stderr.on('data', (chunk: string) => {
			this.stderrLog.push(chunk);
			let total = 0;
			for (const s of this.stderrLog) { total += s.length; }
			while (total > 1_000_000 && this.stderrLog.length > 1) {
				const dropped = this.stderrLog.shift();
				if (dropped) { total -= dropped.length; }
			}
		});
		// Megaudit-2 m5: stderr can emit 'error' (e.g. underlying pipe
		// error). Without a listener Node crashes the process. Route
		// through failPending so pending requests reject cleanly and
		// the lifecycle drives a clean respawn.
		this.child.stderr.on('error', (err: Error) => {
			this.failPending(new DaemonClosedError(`stderr error: ${err.message}`));
		});

		this.stdin.on('drain', () => this.onDrain());
		// Audit-fix AF5: stdin can emit 'error' (e.g. EPIPE when daemon
		// dies, ERR_STREAM_WRITE_AFTER_END after end()). Without a listener
		// Node would crash the process. Capture and route through
		// failPending so pending requests reject cleanly.
		this.stdin.on('error', (err: Error) => {
			this.failPending(new DaemonClosedError(`stdin error: ${err.message}`));
		});

		this.stdout.on('data', (chunk: Buffer) => this.onStdoutChunk(chunk));
		this.stdout.on('end', () => this.handleClose('stdout ended'));
		this.child.on('exit', (code, signal) => {
			this.handleClose(`daemon exited (code=${code} signal=${signal ?? 'none'})`);
		});
		this.child.on('error', (err) => {
			this.fatal = new DaemonClosedError(`daemon spawn failed: ${err.message}`);
			this.handleClose(this.fatal.message);
		});

		// Audit-fix AF9: banner timeout. Without this, a broken venv or
		// missing module hangs `ready()` forever.
		const bannerTimeoutMs = opts.bannerTimeoutMs;
		this.bannerPromise = new Promise<DaemonBanner>((resolve, reject) => {
			const bannerWaiter: PendingRequest = {
				id: 0,
				op: '__banner__',
				expectsArrow: false,
				resolve: ({ json }) => {
					this.clearBannerTimer();
					const b = json as DaemonBanner;
					if (!b || b.daemon !== 'qviz') {
						// Megaudit-2 m3: route banner-shape failure
						// through failPending so the client transitions
						// to fatal AND any subsequently-pipelined
						// requests fail loudly rather than racing into
						// protocol desync (the daemon's first frame
						// was just consumed as the "banner").
						const err = new DaemonProtocolError(
							`unexpected banner: ${JSON.stringify(json)}`,
						);
						this.failPending(err);
						reject(err);
						return;
					}
					resolve(b);
				},
				reject: (e) => { this.clearBannerTimer(); reject(e); },
			};
			this.orderedQueue.push(bannerWaiter);
			this.bannerTimer = setTimeout(() => {
				this.bannerTimer = null;
				const err = new DaemonProtocolError(
					`daemon did not send banner within ${bannerTimeoutMs}ms`
				);
				this.failPending(err);
			}, bannerTimeoutMs);
			// Don't keep the event loop alive on the timer.
			if (typeof this.bannerTimer.unref === 'function') {
				this.bannerTimer.unref();
			}
		});
	}

	private clearBannerTimer(): void {
		if (this.bannerTimer !== null) {
			clearTimeout(this.bannerTimer);
			this.bannerTimer = null;
		}
	}

	// -----------------------------------------------------------------------
	// public surface
	// -----------------------------------------------------------------------

	/** Wait for the daemon's banner. Resolves with the protocol metadata.
	 *  Rejects with DaemonProtocolError if the bannerTimeoutMs deadline
	 *  passes without a valid banner. */
	ready(): Promise<DaemonBanner> {
		return this.bannerPromise;
	}

	async ping(): Promise<JsonResponse<{ pong: boolean; workspace: string }>> {
		return this.callJson<{ pong: boolean; workspace: string }>('ping', {});
	}

	async schema(path: string): Promise<JsonResponse<SchemaData>> {
		return this.callJson<SchemaData>('schema', { path });
	}

	async preview(
		path: string, n?: number, offset?: number,
		opts: {
			inspectorFilters?: readonly InspectorFilterDTO[];
			applySpecTransforms?: QvizSpec;
		} = {},
	): Promise<JsonResponse<{ rows: readonly Record<string, unknown>[]; n: number }>
		| ArrowResponse<PreviewMeta>> {
		const payload: Record<string, unknown> = { path };
		if (n !== undefined) { payload.n = n; }
		// Phase 6 (6.A.1): offset omitted on pre-Phase-6 callers; the
		// daemon defaults to 0 there, preserving the original contract.
		if (offset !== undefined) { payload.offset = offset; }
		// Phase 6 (6.D extension): inspector_filters threads ephemeral
		// inspector filters through to the daemon's filtered-preview path.
		// Omitted when empty so the daemon's fast iter_batches path runs
		// and the cache key matches pre-Phase-6 unfiltered previews.
		if (opts.inspectorFilters && opts.inspectorFilters.length > 0) {
			payload.inspector_filters = opts.inspectorFilters;
		}
		// Megaudit B-10 cure: when the spec has aggregate/groupby transforms
		// AND the inspector is open, pass the full spec via
		// `applySpecTransforms`. The daemon then routes the preview through
		// compile_spec so the inspector sees the aggregated shape (matches
		// the chart) instead of raw pre-aggregate rows.
		if (opts.applySpecTransforms) {
			payload.apply_spec_transforms = opts.applySpecTransforms;
		}
		const r = await this.callJsonOrArrow('preview', payload);
		// callJsonOrArrow returns the union typed as `unknown` payload; the
		// daemon's `preview` op is documented to produce either a JSON
		// rows-array (small) or an Arrow IPC frame (large). The narrower
		// types here are the ergonomic shape for callers; the cast is
		// safe by daemon contract.
		return r as JsonResponse<{ rows: readonly Record<string, unknown>[]; n: number }>
			| ArrowResponse<PreviewMeta>;
	}

	async aggregate(
		spec: QvizSpec,
		opts: { inspectorFilters?: readonly InspectorFilterDTO[] } = {},
	): Promise<ArrowResponse<AggregateMeta>> {
		// Phase 6 (6.A.3): inspector_filters is OMITTED when no filters are
		// active so the cache key on the daemon side stays identical to
		// pre-Phase-6 (avoids cache invalidation of every prior result on
		// first deploy). Snake-case key matches the daemon's expectation.
		const payload: Record<string, unknown> = { spec };
		if (opts.inspectorFilters && opts.inspectorFilters.length > 0) {
			payload.inspector_filters = opts.inspectorFilters;
		}
		const r = await this.callJsonOrArrow('aggregate', payload);
		if (!('arrow' in r)) {
			throw new DaemonProtocolError(`aggregate returned non-arrow encoding`);
		}
		return r as ArrowResponse<AggregateMeta>;
	}

	/** Phase 6 (6.A.2): summary stats for one column, used by the
	 *  inspector's filter widgets. */
	async columnStats(
		path: string, column: string,
		opts: { applySpecTransforms?: QvizSpec } = {},
	): Promise<JsonResponse<ColumnStatsData>> {
		// Megaudit B-10 cure: when the column being queried is a derived
		// alias from the spec's aggregate pipeline (e.g. `pnl_sum`,
		// `exposure_mean`), pass `applySpecTransforms` so the daemon
		// compiles the spec and queries the aggregated output instead of
		// the raw parquet (which doesn't know about derived columns).
		const payload: Record<string, unknown> = { path, column };
		if (opts.applySpecTransforms) {
			payload.apply_spec_transforms = opts.applySpecTransforms;
		}
		return this.callJson<ColumnStatsData>('column_stats', payload);
	}

	async decimate(
		path: string, x_col: string, y_col: string, n_visible?: number,
		carry_cols?: readonly string[],
	): Promise<ArrowResponse<DecimateMeta>> {
		// M-18 cure: when decimating a candlestick (or any multi-column
		// chart), pass the non-primary OHLC/V columns as carry_cols so
		// the daemon samples them at LTTB-picked indices alongside y_col.
		const r = await this.callJsonOrArrow('decimate', {
			path, x_col, y_col,
			...(n_visible !== undefined ? { n_visible } : {}),
			...(carry_cols && carry_cols.length > 0 ? { carry_cols: [...carry_cols] } : {}),
		});
		if (!('arrow' in r)) {
			throw new DaemonProtocolError(`decimate returned non-arrow encoding`);
		}
		return r as ArrowResponse<DecimateMeta>;
	}

	async stats(): Promise<JsonResponse<unknown>> {
		return this.callJson<unknown>('stats', {});
	}

	/**
	 * Fetch the daemon's capability descriptor. Step 5.G.1: the
	 * webview's transform menu MUST be generated from this list so the
	 * UI never offers a variant the compiler doesn't accept. The
	 * provider fetches once per lifecycle and injects into init.capabilities.
	 */
	async capabilities(): Promise<JsonResponse<DaemonCapabilitiesData>> {
		return this.callJson<DaemonCapabilitiesData>('capabilities', {});
	}

	/**
	 * Subscribe to daemon-close events. Fires once when the underlying
	 * process closes for any reason (stdout EOF, child exit, spawn error,
	 * protocol violation, banner timeout, OR explicit dispose). Multiple
	 * handlers may register; each receives the same Error and the
	 * `intended` flag (true iff close was caused by an explicit
	 * `dispose()` call; false for crashes).
	 *
	 * If the client has ALREADY closed by the time `onClose()` is called,
	 * the handler is invoked synchronously with the captured close info.
	 * This guarantees no late-subscriber misses the event (Step B
	 * megaudit Major: prior code cleared `closeHandlers` after firing,
	 * and a handler subscribed during firing would never be invoked).
	 *
	 * Used by `daemon-lifecycle.ts` to drive auto-respawn on unexpected
	 * close.
	 */
	onClose(handler: (info: { error: Error; intended: boolean }) => void): () => void {
		if (this.closeInfo !== null) {
			// Already closed: fire synchronously so the caller sees the
			// terminal state in their own call frame.
			handler(this.closeInfo);
			return () => { /* nothing to detach */ };
		}
		this.closeHandlers.push(handler);
		return () => {
			const idx = this.closeHandlers.indexOf(handler);
			if (idx >= 0) { this.closeHandlers.splice(idx, 1); }
		};
	}

	/**
	 * Tear down the daemon process. Pending requests reject deterministically
	 * BEFORE this resolves (audit-fix AF6: previously, dispose() could resolve
	 * after SIGKILL without guaranteeing handleClose ran).
	 */
	async dispose(): Promise<void> {
		this.intendedClose = true;
		if (this.closed) {
			// Megaudit-2 A1-m4: child may have died on its own before
			// dispose() was called; handleClose captured
			// `closeInfo.intended = false` at that time. Now that the
			// user has explicitly disposed, update the captured intent
			// so late `onClose()` subscribers (e.g., the lifecycle
			// manager's auto-respawn logic) see `intended: true` and
			// don't try to restart.
			if (this.closeInfo !== null && !this.closeInfo.intended) {
				this.closeInfo = { error: this.closeInfo.error, intended: true };
			}
			return;
		}
		// Mark closed + reject pending synchronously so any caller that
		// awaits `client.dispose()` before awaiting in-flight ops sees the
		// rejection in the same tick.
		this.handleClose('dispose() called');

		// Now end stdin and wait for the child to exit (with a grace
		// period before SIGKILL).
		if (this.stdin.writable) {
			this.stdin.end();
		}
		await new Promise<void>(resolve => {
			let done = false;
			const finish = () => { if (!done) { done = true; resolve(); } };
			const timer = setTimeout(() => {
				if (!this.child.killed) {
					this.child.kill('SIGKILL');
				}
				finish();
			}, this.disposeGraceMs);
			if (this.child.exitCode !== null || this.child.signalCode !== null) {
				clearTimeout(timer);
				finish();
				return;
			}
			this.child.once('exit', () => { clearTimeout(timer); finish(); });
		});
	}

	/** Captured stderr text. Useful for surfacing daemon crash diagnostics. */
	stderr(): string {
		return this.stderrLog.join('');
	}

	// -----------------------------------------------------------------------
	// internals: request dispatch
	// -----------------------------------------------------------------------

	private async callJson<T>(op: string, payload: object): Promise<JsonResponse<T>> {
		const r = await this.requestRaw(op, payload, /* expectsArrow */ false);
		return this.unpackJson<T>(r.json);
	}

	private async callJsonOrArrow(
		op: string, payload: object
	): Promise<JsonResponse<unknown> | ArrowResponse<unknown>> {
		const r = await this.requestRaw(op, payload, /* expectsArrow */ true);
		const obj = r.json as RawDaemonResponse;
		const elapsedMs = requireFiniteElapsed(obj.elapsed_ms, op);
		if (obj.encoding === 'arrow') {
			if (!r.arrow) {
				throw new DaemonProtocolError(
					`op '${op}' response said encoding=arrow but no arrow frame followed`
				);
			}
			const cached = readCached(obj.data, op);
			return { meta: obj.data, arrow: r.arrow, elapsedMs, cached };
		}
		return { data: obj.data, elapsedMs, cached: readCachedOptional(obj.data) };
	}

	private unpackJson<T>(raw: unknown): JsonResponse<T> {
		const obj = raw as RawDaemonResponse;
		return {
			data: obj.data as T,
			elapsedMs: requireFiniteElapsed(obj.elapsed_ms, '<json>'),
			cached: readCachedOptional(obj.data),
		};
	}

	private async requestRaw(
		op: string, payload: object, expectsArrow: boolean
	): Promise<{ json: unknown; arrow?: Uint8Array }> {
		if (this.fatal) { return Promise.reject(this.fatal); }
		if (this.closed) {
			return Promise.reject(new DaemonClosedError('daemon already closed'));
		}
		const id = this.nextId++;
		const requestObj = { id, op, ...payload };

		// Audit-fix AF8: reject oversized outgoing frames CLIENT-side rather
		// than blast bytes the daemon will reject. The error message is
		// useful (op + size); the daemon's MAX_FRAME_BYTES error wouldn't be.
		const payloadBytes = Buffer.from(JSON.stringify(requestObj), 'utf-8');
		if (payloadBytes.length > MAX_FRAME_BYTES) {
			return Promise.reject(new DaemonProtocolError(
				`outgoing op '${op}' frame too large: ${payloadBytes.length} > ${MAX_FRAME_BYTES}`
			));
		}

		// Build the pending entry up-front so it lives in `orderedQueue`
		// BEFORE any await. This way failPending() (e.g. from a concurrent
		// dispose() or daemon close) deterministically rejects this
		// request even if the await below has not yet resumed.
		let resolveFn!: (resp: { json: unknown; arrow?: Uint8Array }) => void;
		let rejectFn!: (err: Error) => void;
		const promise = new Promise<{ json: unknown; arrow?: Uint8Array }>((res, rej) => {
			resolveFn = res;
			rejectFn = rej;
		});
		const entry: PendingRequest = {
			id, op, expectsArrow,
			resolve: ({ json, arrow }) => resolveFn({ json, arrow }),
			reject: rejectFn,
		};
		this.pending.set(id, entry);
		this.orderedQueue.push(entry);

		// Megaudit CRITICAL-9: chain this write onto the previous one
		// so writes execute in the order they were enqueued, regardless
		// of which one had to park on drain. We MUST tail-update
		// `writeChain` BEFORE awaiting, so the next concurrent caller
		// chains onto us rather than onto our predecessor.
		const prevTail = this.writeChain;
		const myTail = (async () => {
			await prevTail;
			// Audit-fix AF11: handle stdin backpressure. write() returns
			// false when the kernel buffer is full; we wait for 'drain'
			// before the next write to avoid memory growth under high
			// request load. Now serialized so order is preserved.
			await this.awaitDrainIfNeeded();
			if (this.fatal || this.closed || !this.stdin.writable) {
				// promise was rejected by failPending; nothing more to do.
				return;
			}
			const header = Buffer.alloc(HEADER_SIZE);
			header.writeUInt32LE(payloadBytes.length, 0);
			header.writeUInt8(FRAME_JSON, 4);
			header.writeUInt8(0, 5);
			try {
				this.stdin.write(header);
				this.stdin.write(payloadBytes);
			} catch (e) {
				this.failPending(new DaemonClosedError(
					`stdin write failed: ${(e as Error).message}`
				));
			}
		})();
		// Suppress unhandled rejections on the chain (each individual
		// write's errors are already routed through failPending / the
		// pending entry's reject).
		this.writeChain = myTail.catch(() => undefined);
		await myTail;
		return promise;
	}

	private awaitDrainIfNeeded(): Promise<void> {
		// If stdin's writableNeedDrain is true, wait for 'drain'. Otherwise
		// resolve synchronously.
		if (!this.stdin.writableNeedDrain) {
			return Promise.resolve();
		}
		return new Promise<void>(resolve => this.drainWaiters.push(resolve));
	}

	private onDrain(): void {
		const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
		for (const w of waiters) { w(); }
	}

	// -----------------------------------------------------------------------
	// internals: stdout parser (chunked, no O(n^2) copy)
	// -----------------------------------------------------------------------

	private onStdoutChunk(chunk: Buffer): void {
		// Megaudit-2 m6: short-circuit when the client is already
		// closed -- otherwise late stdout chunks accumulate in
		// `this.buffer` and re-trigger failPending paths via
		// tryEmitFrame.
		if (this.closed || this.fatal !== null) { return; }
		this.buffer.push(chunk);
		while (this.tryEmitFrame()) {
			// keep draining
		}
	}

	private tryEmitFrame(): boolean {
		if (this.buffer.size < HEADER_SIZE) { return false; }
		const length = this.buffer.readUint32LE(0);
		const tag = this.buffer.readUint8(4);
		const reserved = this.buffer.readUint8(5);
		if (reserved !== 0) {
			this.failPending(new DaemonProtocolError(
				`frame reserved byte must be 0, got ${reserved}`
			));
			return false;
		}
		if (length > MAX_FRAME_BYTES) {
			this.failPending(new DaemonProtocolError(
				`incoming frame too large: ${length} > ${MAX_FRAME_BYTES}`
			));
			return false;
		}
		const total = HEADER_SIZE + length;
		if (this.buffer.size < total) { return false; }

		const payload = this.buffer.slice(HEADER_SIZE, length);
		this.buffer.consume(total);
		this.dispatchFrame(tag, payload);
		return true;
	}

	private dispatchFrame(tag: number, payload: Uint8Array): void {
		if (this.awaitingArrowFor) {
			const pending = this.awaitingArrowFor;
			this.awaitingArrowFor = null;
			if (tag !== FRAME_ARROW_IPC) {
				// Audit-fix AF4: a wrong-type frame in the arrow-following
				// slot is a fatal protocol desync. Reject EVERY pending
				// request, not just this one, since any subsequent frame
				// is now mis-aligned with the rest of the queue.
				//
				// Megaudit-2 C1: pending was already removed from
				// `orderedQueue` and `this.pending` Map when its JSON
				// head was dispatched, AND we just nulled
				// `awaitingArrowFor`. failPending below would NEVER
				// reject this specific pending. Reject it explicitly
				// FIRST so the caller's promise resolves; THEN drain
				// the rest of the protocol state via failPending.
				const desyncErr = new DaemonProtocolError(
					`expected Arrow frame after arrow-encoded response for op '${pending.op}', got tag ${tag}`,
				);
				pending.reject(desyncErr);
				this.failPending(desyncErr);
				return;
			}
			pending.resolve({ json: this.lastJsonForArrow, arrow: payload });
			this.lastJsonForArrow = null;
			return;
		}

		if (tag === FRAME_JSON) {
			let obj: unknown;
			try {
				obj = JSON.parse(Buffer.from(payload).toString('utf-8'));
			} catch (e) {
				this.failPending(new DaemonProtocolError(
					`malformed JSON frame: ${(e as Error).message}`
				));
				return;
			}
			this.dispatchJson(obj);
			return;
		}

		if (tag === FRAME_ARROW_IPC) {
			this.failPending(new DaemonProtocolError(
				'received Arrow frame with no preceding arrow-encoded JSON response'
			));
			return;
		}

		this.failPending(new DaemonProtocolError(`unknown frame tag: ${tag}`));
	}

	private dispatchJson(obj: unknown): void {
		const head = this.orderedQueue.shift();
		if (!head) {
			this.failPending(new DaemonProtocolError(
				`unexpected JSON frame with no pending request: ${JSON.stringify(obj)}`
			));
			return;
		}
		// Banner: id 0, no daemon-side correlation -- it's the first frame.
		if (head.op === '__banner__') {
			head.resolve({ json: obj });
			return;
		}

		this.pending.delete(head.id);
		const r = obj as RawDaemonResponse;

		// Audit-fix AF4 + Megaudit-2 CODEX-3: id mismatch is a fatal
		// desync. The previous check was `typeof r.id === 'number' &&
		// r.id !== head.id` -- which silently ACCEPTED missing/string/
		// null ids by attributing them to the queue head. Now: require
		// id to be a number that exactly matches head.id.
		if (typeof r.id !== 'number' || r.id !== head.id) {
			// Restore the head into the queue so failPending picks it up too.
			this.orderedQueue.unshift(head);
			this.failPending(new DaemonProtocolError(
				`response id ${JSON.stringify(r.id)} did not match request id ${head.id} (or was malformed); protocol desync`,
			));
			return;
		}

		if (r.ok === false) {
			if (typeof r.error !== 'string' || r.error.length === 0) {
				const desync = new DaemonProtocolError(
					`response for op '${head.op}' has ok=false but missing/empty error field; protocol drift`,
				);
				this.orderedQueue.unshift(head);
				this.failPending(desync);
				return;
			}
			// Megaudit MAJOR-34: propagate structured error_kind from
			// the daemon response so the provider can map to the
			// protocol's typed errorKind without parsing message strings.
			// Megaudit F3 (2026-05-13): strict decode — unknown/missing
			// error_kind now surfaces as DaemonProtocolError instead of
			// silently classifying as 'compile'. Callers expecting
			// `errorKind === 'compile'` for legacy daemons must update;
			// the Python side has emitted error_kind on every response
			// since the protocol layer was introduced.
			let errorKind: DaemonErrorKind;
			try {
				errorKind = decodeDaemonErrorKind(r.error_kind, head.op);
			} catch (e) {
				this.orderedQueue.unshift(head);
				this.failPending(e as DaemonProtocolError);
				return;
			}
			head.reject(new DaemonOpError(
				r.error, requireFiniteElapsed(r.elapsed_ms, head.op), errorKind,
			));
			return;
		}

		// Megaudit MAJOR-18: `r.ok` MUST be a boolean per the daemon
		// contract. A missing/non-boolean `ok` falling through to the
		// arrow-park branch would deadlock the request waiting for an
		// arrow follow-up the (presumably misbehaving) daemon will
		// never send. Fail loudly on protocol drift here.
		if (r.ok !== true) {
			const desync = new DaemonProtocolError(
				`response for op '${head.op}' has non-boolean ok field (${JSON.stringify(r.ok)}); protocol drift`,
			);
			this.orderedQueue.unshift(head);
			this.failPending(desync);
			return;
		}

		if (head.expectsArrow && r.encoding === 'arrow') {
			// Defer resolution: the next frame is the Arrow follow-up.
			this.lastJsonForArrow = obj;
			this.awaitingArrowFor = head;
			return;
		}

		head.resolve({ json: obj });
	}

	// -----------------------------------------------------------------------
	// internals: lifecycle
	// -----------------------------------------------------------------------

	private handleClose(reason: string): void {
		if (this.closed) { return; }
		this.closed = true;
		const err = this.fatal ?? new DaemonClosedError(
			`daemon closed: ${reason}${this.stderr() ? '\n--- stderr ---\n' + this.stderr() : ''}`
		);
		this.failPendingInternal(err);
		// Wake any drainWaiters so awaitDrainIfNeeded callers get a chance
		// to see the closed state.
		const waiters = this.drainWaiters.splice(0, this.drainWaiters.length);
		for (const w of waiters) { w(); }
		// Force-terminate the child if it's still running. Without this,
		// a `failPending` path that DOESN'T come via `dispose()` (banner
		// timeout, protocol violation, oversized incoming frame) would
		// leak the python process. `dispose()` itself sets `intendedClose`
		// before calling `handleClose`; the timer-and-SIGKILL path runs
		// in `dispose()` after `handleClose` returns. For the unintended
		// path we kill immediately so retries don't compound zombies.
		if (!this.intendedClose && this.child.exitCode === null && this.child.signalCode === null) {
			try { this.child.kill('SIGKILL'); } catch (e) {
				// Megaudit MAJOR-18: only swallow ESRCH ("no such
				// process" -- child already gone). Any other kill error
				// (EPERM, EINVAL) is a real condition that MUST surface
				// rather than silently disappear.
				const code = (e as NodeJS.ErrnoException).code;
				if (code !== 'ESRCH') {
					console.warn(
						`QvizDaemonClient: SIGKILL on child PID ${this.child.pid} failed (${code}):`,
						e,
					);
				}
			}
		}
		// Capture close info so late `onClose()` subscribers still see it.
		const intended = this.intendedClose;
		const info = { error: err, intended };
		this.closeInfo = info;
		// Snapshot AND clear so a handler that subscribes another handler
		// during firing has its new handler invoked synchronously via the
		// late-subscriber fast-path in `onClose()`.
		const handlers = this.closeHandlers.splice(0, this.closeHandlers.length);
		for (const h of handlers) {
			h(info);
		}
	}

	/**
	 * Reject ALL pending work with the given error and put the client in
	 * a fatal state, and force-close the underlying process. Reachable
	 * from many internal sites (banner timeout, protocol violation,
	 * oversized incoming frame, malformed JSON, arrow-after-arrow desync,
	 * stdin error, child error event). All of them must terminate the
	 * child so we don't leak python processes (Step B megaudit C6/C9).
	 */
	private failPending(err: Error): void {
		this.failPendingInternal(err);
		// Route through handleClose so the close handlers, drainWaiters,
		// and child-kill all happen exactly once. handleClose is idempotent
		// on `this.closed`; calling it again is a no-op.
		if (!this.closed) {
			this.handleClose(`failPending: ${err.message}`);
		}
	}

	/** Inner version that drains pending state without triggering the
	 *  close cascade. Used by `handleClose` itself to avoid recursion. */
	private failPendingInternal(err: Error): void {
		this.fatal = this.fatal ?? err;
		this.clearBannerTimer();
		// Reject the head + all queued requests in order.
		while (this.orderedQueue.length > 0) {
			const p = this.orderedQueue.shift();
			if (!p) { break; }
			p.reject(err);
		}
		// And the parked arrow-waiter, if any.
		if (this.awaitingArrowFor) {
			this.awaitingArrowFor.reject(err);
			this.awaitingArrowFor = null;
		}
		this.pending.clear();
		this.lastJsonForArrow = null;
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

interface RawDaemonResponse {
	readonly id?: number;
	readonly ok?: boolean;
	readonly data?: unknown;
	readonly encoding?: 'json' | 'arrow';
	readonly elapsed_ms?: number;
	readonly error?: string;
	/** Megaudit MAJOR-34: structured error category from daemon. */
	readonly error_kind?: string;
}

/** Validate the daemon's `elapsed_ms` field. Missing/non-finite values
 *  are protocol drift, not "default to 0" -- a fallback there hides
 *  daemon-side bugs (Codex audit flag). */
function requireFiniteElapsed(value: unknown, op: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
		throw new DaemonProtocolError(
			`response for op '${op}' has invalid elapsed_ms (${JSON.stringify(value)}); `
			+ 'expected non-negative finite number',
		);
	}
	return value;
}

/** Read the `cached` field from an arrow response's meta object. The
 *  daemon's contract states meta MUST include this for arrow responses. */
function readCached(data: unknown, op: string): boolean {
	if (data === null || typeof data !== 'object') {
		throw new DaemonProtocolError(
			`response for op '${op}' has non-object data; expected { cached: boolean, ... }`,
		);
	}
	const v = (data as { cached?: unknown }).cached;
	if (typeof v !== 'boolean') {
		throw new DaemonProtocolError(
			`response for op '${op}' missing 'cached: boolean' in data; got ${JSON.stringify(v)}`,
		);
	}
	return v;
}

/** Read the optional `cached` field on a JSON response's data. JSON
 *  responses MAY include `cached`; if present it must be boolean. */
function readCachedOptional(data: unknown): boolean | undefined {
	if (data === null || typeof data !== 'object') { return undefined; }
	const v = (data as { cached?: unknown }).cached;
	if (v === undefined) { return undefined; }
	if (typeof v !== 'boolean') {
		throw new DaemonProtocolError(
			`response data.cached must be boolean if present, got ${JSON.stringify(v)}`,
		);
	}
	return v;
}
