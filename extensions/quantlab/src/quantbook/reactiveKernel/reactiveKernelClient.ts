/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5-1d-0 -- ReactiveKernelClient: the in-extension transport for the reactive moat.
//
// This is the TS re-implementation of the headless 1c-1/1c-2 Node host
// (`reactive_kernel_host_real.mjs`, engine `fc40e78dc18`), brought INTO the shipped extension. It
// spawns the relocated `python/reactive_kernel/reactive_kernel_supervisor.py` over a 4-fd stdio
// protocol, reads the kernel's republish frames off fd 3 (NDJSON), and APPLIES them to a napi
// Session -- so a Python var edit recomputes the grid live.
//
//   ReactiveKernelClient (THIS; owns NOTHING -- the Session is INJECTED by the caller)
//        |  stdin: {execute|epoch_change|unpublish|close}    ^ fd 3: {ready|republish|stale|executed|epoch_done|unpublished|error|closed}
//        v                                                    |  fd 1: cell stdout (drained)   fd 2: kernel stderr (inherited)
//   reactive_kernel_supervisor.py (jupyter_client)  <-ZMQ->  REAL ipykernel
//
// CURSOR-LESS BY DESIGN (the section 14.4 mandate): unlike the spike host, this client NEVER calls
// `snapshotDelta` and holds NO version cursor. It writes the INJECTED Session (`publishDataset` +
// `recalcDirty`) and signals the caller via `onChanged()`; the caller (a CellGridPanel in 1d-1)
// repaints through the SOLE shared per-session cursor (`acquireWorkbookSnapshotViaDelta`), which
// already reseeds-not-throws on a legitimate fullRebuild. Two cursors would desync -> perpetual
// fullRebuilds; there is exactly one, and it lives in the render path.
//
// No-Fallbacks: every protocol violation / kernel error / spawn failure rejects the in-flight op
// AND is surfaced via `onError` -- never a silently-skipped republish. Teardown is SIGTERM->grace->
// SIGKILL so the supervisor runs its shutdown and the real ipykernel is NOT orphaned.
//
// vscode-free (type-only imports) so it compiles in the extension AND runs in a headless harness.

import { spawn, type ChildProcess } from 'node:child_process';
import * as readline from 'node:readline';

import type { CellRangeJson, CellSnapshotJson, OperationStateJson } from '../types';
import { PublishedCellsStore, type PublishedRange } from './publishedCellsStore';

/** The minimal napi Session surface the client writes. `SessionInstance` satisfies it structurally. */
export interface ReactiveSession {
	publishDataset(name: string, data: string, target: CellRangeJson): unknown;
	recalcDirty(): bigint;
	operationStatus(op: bigint): OperationStateJson;
	cell(sheet: number, row: number, col: number): CellSnapshotJson | null;
}

/** A G3 refusal: the host declined to overwrite a user FORMULA in the target (surfaced, not silent). */
export interface G3Refusal {
	name: string;
	detail: string;
}

/** Outcome of one `execute`/`epochChange` op. The caller asserts via Session ground truth. */
export interface ReactiveOpResult {
	/** republish frames the host APPLIED to the Session this op. */
	republishCount: number;
	/** G3 refusals recorded this op (each rolled back in the kernel via `unpublish`). */
	refused: G3Refusal[];
	/** names the kernel marked STALE (del'd var still referenced) this op. */
	stale: string[];
}

export interface ReactiveKernelClientOptions {
	/** Resolved interpreter to spawn the supervisor with (1d-1: `resolveQuantlabPython`). */
	pythonPath: string;
	/** Absolute path to the relocated `reactive_kernel_supervisor.py`. */
	supervisorScript: string;
	/** The napi Session to apply republishes to -- INJECTED; the client never creates one. */
	session: ReactiveSession;
	/** Map a sheet-qualified A1 target ("Sheet!A1:C3") to a CellRangeJson on `session`. */
	resolveTarget: (a1: string) => CellRangeJson;
	/** Called once after an op that applied >=1 republish (1d-1: `CellGridPanel.refreshSession`). */
	onChanged: () => void;
	/** Surface a host/kernel error to the user (1d-2: output channel + toast). Never swallow. */
	onError: (message: string) => void;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	readyTimeoutMs?: number;
	opTimeoutMs?: number;
	closeTimeoutMs?: number;
}

type ControlFrame =
	| { type: 'ready' }
	| { type: 'republish'; name: string; values: Array<Array<number | string | boolean | null>>; target: string; overwrite?: boolean }
	| { type: 'stale'; name: string }
	| { type: 'executed'; ok: true }
	| { type: 'epoch_done' }
	| { type: 'unpublished' }
	| { type: 'error'; error: string }
	| { type: 'closed' };

interface PendingOp {
	/** the terminal frame this op expects (MED fold: reject a mis-correlated terminal). */
	expect: 'executed' | 'epoch_done' | 'unpublished';
	republishCount: number;
	refused: G3Refusal[];
	stale: string[];
	resolve: (r: ReactiveOpResult) => void;
	reject: (e: Error) => void;
}

/** An Error carrying the partial op state (HIGH fold: a publish-then-raise cell still repaints). */
interface PartialOpError {
	republishCount?: number;
	refused?: G3Refusal[];
	stale?: string[];
}

const DEFAULT_READY_TIMEOUT_MS = 60_000; // kernel spawn + bootstrap injection (real ZMQ kernel)
const DEFAULT_OP_TIMEOUT_MS = 30_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 10_000;
const STDOUT_RING = 64; // keep the last N cell-stdout lines for diagnostics only

export class ReactiveKernelClient {
	private readonly opts: Required<Pick<ReactiveKernelClientOptions, 'readyTimeoutMs' | 'opTimeoutMs' | 'closeTimeoutMs'>> &
		ReactiveKernelClientOptions;
	private child: ChildProcess | undefined;
	private pending: PendingOp | undefined;
	private fatal: Error | undefined;

	private readyResolve!: () => void;
	private readyReject!: (e: Error) => void;
	private readyDone = false;
	private readonly readyPromise: Promise<void>;
	private readyTimer: NodeJS.Timeout | undefined;

	private closing = false;
	private sawClosed = false;
	private sawCleanExit = false;
	private closeResolve: (() => void) | undefined;
	private closeReject: ((e: Error) => void) | undefined;

	private killed = false;
	private readonly cellStdout: string[] = [];
	private readonly closeListeners: Array<(err: Error | undefined) => void> = [];
	// W-G bound-cell indicator: tracks which cells each published variable currently drives (recorded in
	// applyRepublish, retracted on stale/refused at the op boundary). Read per-sheet by the CellGridPanel.
	private readonly publishedCells = new PublishedCellsStore();

	constructor(options: ReactiveKernelClientOptions) {
		this.opts = {
			...options,
			readyTimeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
			opTimeoutMs: options.opTimeoutMs ?? DEFAULT_OP_TIMEOUT_MS,
			closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
		};
		this.readyPromise = new Promise<void>((res, rej) => {
			this.readyResolve = () => {
				this.readyDone = true;
				res();
			};
			this.readyReject = (e) => {
				this.readyDone = true;
				rej(e);
			};
		});
	}

	/** Spawn the supervisor and resolve once it emits `ready`. Call exactly once. */
	start(): Promise<void> {
		if (this.child) {
			throw new Error('ReactiveKernelClient.start() called twice');
		}
		// fd0 stdin (host->supervisor), fd1 cell stdout (drained), fd2 kernel stderr (inherited),
		// fd3 control/republish plane (NDJSON). `-u` = unbuffered so frames are not stranded.
		const child = spawn(this.opts.pythonPath, ['-u', this.opts.supervisorScript], {
			stdio: ['pipe', 'pipe', 'inherit', 'pipe'],
			cwd: this.opts.cwd,
			env: this.opts.env,
		});
		this.child = child;

		this.readyTimer = setTimeout(() => {
			if (!this.readyDone) {
				this.failProtocol(new Error(`reactive kernel did not become ready within ${this.opts.readyTimeoutMs}ms`));
			}
		}, this.opts.readyTimeoutMs);

		child.on('error', (e) => this.failProtocol(new Error(`reactive kernel spawn failed: ${e.message}`)));
		child.on('exit', (code, sig) => this.onExit(code, sig));

		if (child.stdout) {
			readline.createInterface({ input: child.stdout }).on('line', (l) => {
				if (l) {
					this.cellStdout.push(l);
					if (this.cellStdout.length > STDOUT_RING) {
						this.cellStdout.shift();
					}
				}
			});
		}
		const ctrl = child.stdio[3];
		if (!ctrl || typeof (ctrl as NodeJS.ReadableStream).on !== 'function') {
			this.failProtocol(new Error('reactive kernel control plane (fd 3) is not readable'));
			return this.readyPromise;
		}
		readline.createInterface({ input: ctrl as NodeJS.ReadableStream }).on('line', (line) => this.onControlLine(line));

		return this.readyPromise;
	}

	/** Resolves when the supervisor is ready; rejects loud if spawn/bootstrap failed. */
	ready(): Promise<void> {
		return this.readyPromise;
	}

	/** Register a close listener (the lifecycle wrapper in 1d-1 uses this for respawn). */
	onClose(listener: (err: Error | undefined) => void): void {
		this.closeListeners.push(listener);
	}

	/** Execute one notebook cell. Applies any republishes to the Session, reconciles G3 refusals. */
	async execute(code: string): Promise<ReactiveOpResult> {
		let result: ReactiveOpResult;
		let thrown: Error | undefined;
		try {
			result = await this.sendOp('executed', { type: 'execute', code });
		} catch (e) {
			thrown = e instanceof Error ? e : new Error(String(e));
			// HIGH (1d-0 Codex fold): a cell can publish THEN raise -- those republishes already
			// mutated the Session, so carry them (NOT just refusals) and STILL repaint below, or the
			// grid silently goes stale on a publish-then-error cell.
			const partial = e as PartialOpError;
			result = { republishCount: partial?.republishCount ?? 0, refused: partial?.refused ?? [], stale: partial?.stale ?? [] };
		}
		// G3 reconcile (on BOTH success and error): roll back each ghost binding the kernel still has.
		// MED (Codex fold): a FAILING rollback must NOT mask the original cell error -- surface it via
		// onError and keep the original as the thrown error.
		for (const ref of result.refused) {
			try {
				await this.sendOp('unpublished', { type: 'unpublish', name: ref.name });
			} catch (rollbackErr) {
				const msg = rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr);
				this.opts.onError(`reactive G3 rollback failed for "${ref.name}": ${msg}`);
				if (!thrown) {
					thrown = rollbackErr instanceof Error ? rollbackErr : new Error(msg);
				}
			}
		}
		// W-G bound-cell indicator: a publish that did NOT land (G3-refused -- the rollback above
		// unpublished it) or a variable the kernel marked STALE drives nothing now, so drop its badge.
		// Records happen per-frame in applyRepublish; retractions are applied here at the op boundary.
		const boundSetChanged = this.retractBadges(result);
		// Repaint if cell DATA changed (a republish landed, even on a publish-then-raise cell) OR the
		// bound-set changed (a badge must clear though no value moved), THEN rethrow.
		if (result.republishCount > 0 || boundSetChanged) {
			this.opts.onChanged();
		}
		if (thrown) {
			throw thrown;
		}
		return result;
	}

	/** R7: signal an undo/redo epoch so the kernel marks every binding force_check. */
	async epochChange(): Promise<ReactiveOpResult> {
		const r = await this.sendOp('epoch_done', { type: 'epoch_change' });
		const boundSetChanged = this.retractBadges(r);
		if (r.republishCount > 0 || boundSetChanged) {
			this.opts.onChanged();
		}
		return r;
	}

	/**
	 * W-G bound-cell indicator: drop the badge for every variable that, this op, the kernel marked STALE
	 * (deleted/undefined) or whose publish was G3-REFUSED (re-targeted onto a user formula -> it landed
	 * nowhere). Returns whether the tracked set actually changed (so the caller repaints to clear the
	 * badge even when no cell value moved). A name and its successful republish never co-occur in one op
	 * (a variable publishes one target per run), so this never erases a fresh record.
	 */
	private retractBadges(result: ReactiveOpResult): boolean {
		let changed = false;
		for (const ref of result.refused) {
			changed = this.publishedCells.markStale(ref.name) || changed;
		}
		for (const name of result.stale) {
			changed = this.publishedCells.markStale(name) || changed;
		}
		return changed;
	}

	/** W-G: the cells each published variable drives on `sheet`, for the CellGridPanel's badge paint. */
	publishedCellsForSheet(sheet: number): PublishedRange[] {
		return this.publishedCells.rangesForSheet(sheet);
	}

	/** B1 MCP: EVERY published range (any sheet, incl. a now-deleted one), for `get_published_variables`
	 *  to enumerate the COMPLETE set rather than only the cells on live sheets. */
	publishedCellsForAllSheets(): Array<{ sheet: number; range: PublishedRange }> {
		return this.publishedCells.allRangesWithSheet();
	}

	/** Graceful shutdown: ask the supervisor to close, require a `closed` frame AND a clean exit. */
	async close(): Promise<void> {
		if (this.fatal) {
			await this.gracefulKill();
			return;
		}
		const child = this.child;
		if (!child || child.exitCode !== null || child.signalCode) {
			return;
		}
		this.closing = true;
		await new Promise<void>((resolve, reject) => {
			const t = setTimeout(() => {
				this.closeResolve = this.closeReject = undefined;
				// HIGH (Codex fold): a close timeout must NOT leave the supervisor + its ipykernel
				// running -- tear them down (SIGTERM-grace-SIGKILL) before surfacing the timeout.
				void this.gracefulKill();
				reject(new Error(`reactive kernel close timed out (sawClosed=${this.sawClosed}, sawCleanExit=${this.sawCleanExit})`));
			}, this.opts.closeTimeoutMs);
			this.closeResolve = () => {
				clearTimeout(t);
				resolve();
			};
			this.closeReject = (e) => {
				clearTimeout(t);
				reject(e);
			};
			child.stdin?.write(`${JSON.stringify({ type: 'close' })}\n`);
		});
	}

	/** Force teardown (SIGTERM->grace->SIGKILL) so the supervisor tears the ipykernel down. */
	dispose(): Promise<void> {
		return this.gracefulKill();
	}

	/** The last few cell-stdout lines (diagnostics only; the control plane is fd 3, never stdout). */
	recentStdout(): readonly string[] {
		return this.cellStdout;
	}

	// ---- internals -------------------------------------------------------

	private onControlLine(line: string): void {
		// `killed` (set by dispose()/gracefulKill) makes this a no-op so a stray republish arriving
		// between SIGTERM and exit cannot write to a Session the caller is about to close (1d-1).
		if (this.fatal || this.killed) {
			return;
		}
		if (line === '') {
			this.failProtocol(new Error('empty control frame'));
			return;
		}
		let f: ControlFrame;
		try {
			f = JSON.parse(line) as ControlFrame;
		} catch {
			this.failProtocol(new Error(`malformed control frame: ${line}`));
			return;
		}
		switch (f.type) {
			case 'ready':
				if (this.readyDone) {
					this.failProtocol(new Error(`duplicate 'ready' frame`));
					break;
				}
				if (this.readyTimer) {
					clearTimeout(this.readyTimer);
				}
				this.readyResolve();
				break;
			case 'republish': {
				if (!this.pending) {
					this.failProtocol(new Error(`stray 'republish' frame: ${String((f as { name?: unknown }).name)}`));
					break;
				}
				// MED (Codex fold): JSON.parse yields untrusted data cast to ControlFrame -- validate the
				// payload shape before applying, don't trust it.
				if (typeof f.name !== 'string' || !Array.isArray(f.values) || typeof f.target !== 'string') {
					this.failProtocol(new Error(`malformed 'republish' frame: ${line}`));
					break;
				}
				try {
					this.applyRepublish(f);
				} catch (e) {
					const p = this.pending;
					this.pending = undefined;
					// HIGH fold: carry the republishes already applied this op so execute() still repaints.
					const err = Object.assign(e instanceof Error ? e : new Error(String(e)), {
						republishCount: p.republishCount,
						refused: p.refused,
						stale: p.stale,
					});
					p.reject(err);
				}
				break;
			}
			case 'stale':
				if (!this.pending) {
					this.failProtocol(new Error(`stray 'stale' frame: ${String((f as { name?: unknown }).name)}`));
					break;
				}
				if (typeof f.name !== 'string') {
					this.failProtocol(new Error(`malformed 'stale' frame: ${line}`));
					break;
				}
				this.pending.stale.push(f.name);
				break;
			case 'executed':
			case 'epoch_done':
			case 'unpublished': {
				if (!this.pending) {
					this.failProtocol(new Error(`stray '${f.type}' frame`));
					break;
				}
				// MED (Codex fold): the terminal must match the op that was sent -- an `epoch_done`
				// arriving for an `execute` (or vice-versa) is a protocol desync, not a success.
				if (f.type !== this.pending.expect) {
					this.failProtocol(new Error(`expected terminal '${this.pending.expect}', got '${f.type}'`));
					break;
				}
				if (f.type === 'executed' && f.ok !== true) {
					this.failProtocol(new Error(`'executed' frame missing ok:true`));
					break;
				}
				const p = this.pending;
				this.pending = undefined;
				p.resolve({ republishCount: p.republishCount, refused: p.refused, stale: p.stale });
				break;
			}
			case 'error': {
				if (typeof f.error !== 'string') {
					this.failProtocol(new Error(`malformed 'error' frame: ${line}`));
					break;
				}
				if (this.pending) {
					const p = this.pending;
					this.pending = undefined;
					// HIGH fold: carry republishCount + stale (not just refused) so a publish-then-raise
					// cell still repaints in execute().
					const err = Object.assign(new Error(`reactive kernel error: ${f.error}`), {
						republishCount: p.republishCount,
						refused: p.refused,
						stale: p.stale,
					});
					this.opts.onError(`reactive kernel error: ${f.error}`);
					p.reject(err);
				} else {
					this.failProtocol(new Error(`reactive kernel error (no in-flight cell): ${f.error}`));
				}
				break;
			}
			case 'closed':
				if (!this.closing) {
					this.failProtocol(new Error(`unexpected 'closed' frame`));
					break;
				}
				this.sawClosed = true;
				this.maybeFinishClose();
				break;
			default:
				this.failProtocol(new Error(`unknown control frame type: ${(f as { type: string }).type}`));
		}
	}

	// Apply ONE republish frame, CURSOR-LESS: G3 preflight, then publishDataset + recalcDirty, then
	// the caller repaints via onChanged (fired once per op in execute/epochChange). No snapshotDelta,
	// no version -- the panel render owns the sole cursor. A formula in the target is REFUSED (G3),
	// surfaced + rolled back, never clobbered.
	private applyRepublish(f: Extract<ControlFrame, { type: 'republish' }>): void {
		const range = this.opts.resolveTarget(f.target);
		if (!f.overwrite) {
			const hit = this.formulaInRange(range);
			if (hit) {
				const detail = `(row=${hit.row},col=${hit.col}) formula ${JSON.stringify(hit.formula)}`;
				this.pending!.refused.push({ name: f.name, detail });
				this.opts.onError(`reactive publish "${f.name}" refused: would overwrite a user formula ${detail}`);
				return;
			}
		}
		this.opts.session.publishDataset(f.name, JSON.stringify({ values: f.values }), range);
		this.recalcChecked();
		this.pending!.republishCount++;
		// W-G bound-cell indicator: the publish landed -- record (latest-wins) that `f.name` now drives
		// `range` so the panel can badge it. In lockstep with republishCount++ (a frame that fails
		// recalcChecked above neither counts nor badges); a G3 refusal returned before reaching here.
		this.publishedCells.recordPublish(f.name, range);
	}

	// HIGH (1d-0 Codex fold): mirror the shipped `recalcDirtyChecked` (session.ts) -- a recalc that
	// did NOT complete throws (No-Fallbacks) instead of leaving the grid showing stale values. In-
	// engine recalc is synchronous, so the op is terminal on return. The throw propagates out of the
	// `republish` handler -> the in-flight op rejects -> execute()/onError surface it.
	private recalcChecked(): void {
		const op = this.opts.session.recalcDirty();
		const status = this.opts.session.operationStatus(op);
		if (status.state !== 'completed') {
			const e = status.error;
			const code = e?.code ?? (status.state === 'failed' ? 'panic' : 'invalid_state');
			const detail = e?.details ? `: ${e.details}` : '';
			throw new Error(`[${code}] reactive recalcDirty did not complete (state=${status.state})${detail}`);
		}
	}

	private formulaInRange(range: CellRangeJson): { row: number; col: number; formula: string } | undefined {
		for (let r = range.startRow; r <= range.endRow; r++) {
			for (let c = range.startCol; c <= range.endCol; c++) {
				const cell = this.opts.session.cell(range.sheet, r, c);
				if (cell && cell.formula !== undefined) {
					return { row: r, col: c, formula: cell.formula };
				}
			}
		}
		return undefined;
	}

	private sendOp(expect: PendingOp['expect'], frame: Record<string, unknown>): Promise<ReactiveOpResult> {
		if (this.fatal) {
			return Promise.reject(this.fatal);
		}
		// HIGH (Codex fold): one op in flight at a time. A concurrent send would overwrite `pending`
		// and orphan the first op's waiter -- reject loudly rather than silently clobber.
		if (this.pending) {
			return Promise.reject(new Error('reactive kernel op already in flight (concurrent ops are not supported)'));
		}
		const child = this.child;
		if (!child || !child.stdin) {
			return Promise.reject(new Error('reactive kernel is not running'));
		}
		return new Promise<ReactiveOpResult>((resolve, reject) => {
			const timer = setTimeout(() => {
				if (this.pending) {
					// HIGH (Codex fold): a timeout is a FATAL protocol fault, not a recoverable reject --
					// a late frame would be misattributed to the next op. Fail loud (onError + kill).
					this.failProtocol(new Error(`reactive kernel op timed out (${this.opts.opTimeoutMs}ms): ${JSON.stringify(frame)}`));
				}
			}, this.opts.opTimeoutMs);
			this.pending = {
				expect,
				republishCount: 0,
				refused: [],
				stale: [],
				resolve: (v) => {
					clearTimeout(timer);
					resolve(v);
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			};
			child.stdin!.write(`${JSON.stringify(frame)}\n`);
		});
	}

	// The SINGLE fatal path: reject every waiter (No-Fallbacks -- never hang a waiter no future frame
	// will resolve, never silently drop a frame). The rejection propagates to the caller, which calls
	// dispose() -> gracefulKill() so the ipykernel is not orphaned.
	private failProtocol(err: Error): void {
		if (this.fatal) {
			return; // idempotent -- already failed (also prevents onExit<->failProtocol re-entry)
		}
		this.fatal = err;
		this.opts.onError(err.message);
		if (!this.readyDone) {
			this.readyReject(err);
		}
		if (this.pending) {
			const p = this.pending;
			this.pending = undefined;
			p.reject(err);
		}
		if (this.closeReject) {
			const r = this.closeReject;
			this.closeResolve = this.closeReject = undefined;
			r(err);
		}
		// HIGH (Codex fold): do NOT rely on the caller to dispose. Tear the supervisor (and its
		// ipykernel) down ourselves on any fatal fault, and notify close listeners with the error.
		void this.gracefulKill();
		this.notifyClose(err);
	}

	private onExit(code: number | null, sig: NodeJS.Signals | null): void {
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
		}
		if (this.killed) {
			// dispose()/gracefulKill (e.g. a user Stop or a last-panel close) initiated this exit -- it
			// is EXPECTED, not a kernel error. Reject any waiters QUIETLY (no onError toast) and notify
			// close listeners with no error. (MED Codex fold: avoid a false "kernel error" on dispose.)
			const err = new Error('reactive kernel disposed');
			if (!this.readyDone) {
				this.readyReject(err);
			}
			if (this.pending) {
				const p = this.pending;
				this.pending = undefined;
				p.reject(err);
			}
			if (this.closeReject) {
				const r = this.closeReject;
				this.closeResolve = this.closeReject = undefined;
				r(err);
			}
			this.notifyClose(undefined);
			return;
		}
		if (this.closing) {
			if (code === 0 && sig === null) {
				this.sawCleanExit = true;
				this.maybeFinishClose();
			} else if (this.closeReject) {
				const r = this.closeReject;
				this.closeResolve = this.closeReject = undefined;
				r(new Error(`reactive kernel exited dirty during close (code=${code}, signal=${sig})`));
			}
			this.notifyClose(undefined);
			return;
		}
		const err = new Error(`reactive kernel exited unexpectedly (code=${code}, signal=${sig})`);
		this.failProtocol(err);
		this.notifyClose(err);
	}

	private maybeFinishClose(): void {
		if (this.sawClosed && this.sawCleanExit && this.closeResolve) {
			const r = this.closeResolve;
			this.closeResolve = this.closeReject = undefined;
			r();
		}
	}

	private notifyClose(err: Error | undefined): void {
		const listeners = this.closeListeners.splice(0);
		for (const l of listeners) {
			l(err);
		}
	}

	private gracefulKill(): Promise<void> {
		if (this.killed) {
			return Promise.resolve();
		}
		this.killed = true;
		const child = this.child;
		return new Promise<void>((resolve) => {
			if (!child || child.exitCode !== null || child.signalCode) {
				resolve();
				return;
			}
			const t = setTimeout(() => {
				try {
					child.kill('SIGKILL');
				} catch {
					/* already dead */
				}
				resolve();
			}, 3000);
			child.once('exit', () => {
				clearTimeout(t);
				resolve();
			});
			try {
				child.kill('SIGTERM'); // the supervisor's handler tears the ipykernel down, then exits
			} catch {
				clearTimeout(t);
				resolve();
			}
		});
	}
}
