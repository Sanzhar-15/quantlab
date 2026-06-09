/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-1.5-1d-1 -- ReactiveKernelManager: the per-Session registry that owns reactive kernels.
//
// One ReactiveKernelClient per owning napi Session, keyed by SESSION IDENTITY (the FE-2-0 host-audit
// invariant: never by sheet). The manager is the orchestration layer between the VS Code command
// shell (reactiveKernelCommands.ts) and the transport client (reactiveKernelClient.ts):
//   - lazy-spawn a kernel for a Session on first start/execute (deduped against a concurrent start);
//   - re-spawn on next use if a prior kernel died (the client surfaced the failure via onError);
//   - dispose a Session's kernel when its LAST CellGridPanel closes (before session.close());
//   - dispose ALL kernels on extension deactivate (awaited, so no orphaned ipykernel).
//
// vscode-free + dependency-injected (a client factory + a trust gate), so it is unit-testable with
// fakes and carries NO VS Code coupling. The trust gate is checked GATE-FIRST on every start/execute
// (No-Fallbacks: an untrusted workspace throws, never silently spawns).

import type { ReactiveOpResult } from './reactiveKernelClient';
import type { PublishedRange } from './publishedCellsStore';

/** The transport surface the manager drives (ReactiveKernelClient implements it; tests fake it). */
export interface ReactiveKernelClientLike {
	start(): Promise<void>;
	execute(code: string): Promise<ReactiveOpResult>;
	epochChange(): Promise<ReactiveOpResult>;
	close(): Promise<void>;
	dispose(): Promise<void>;
	onClose(listener: (err: Error | undefined) => void): void;
	/** W-G bound-cell indicator: the cells each published variable drives on `sheet`. */
	publishedCellsForSheet(sheet: number): PublishedRange[];
	/** B1 MCP: EVERY published range with its (possibly deleted) sheet, for `get_published_variables`. */
	publishedCellsForAllSheets(): Array<{ sheet: number; range: PublishedRange }>;
}

/**
 * @param session the owning napi Session a kernel is bound to (used only as a Map key).
 * @typeParam S the Session type -- generic so tests can key on a plain object.
 */
export class ReactiveKernelManager<S = object> {
	private readonly clients = new Map<S, ReactiveKernelClientLike>();
	// In-flight starts carry the actual client (not just a promise) so disposal can CANCEL + tear down
	// a kernel that is still starting -- the HIGH-fold for the startup/dispose race.
	private readonly starting = new Map<S, { client: ReactiveKernelClientLike; promise: Promise<ReactiveKernelClientLike> }>();

	/**
	 * @param assertTrusted throws (gate-first) when the workspace is not trusted to run kernel code.
	 * @param clientFactory builds (does NOT start) a client bound to `session`.
	 * @param onClientRemoved **W-G**: invoked (once) when a REGISTERED client is removed from the registry
	 *   -- explicitly disposed (`disposeSession`) or lost on an unexpected close. The store dies with the
	 *   client, so the host must refresh the session's still-open panels to clear now-orphaned bound-cell
	 *   badges (else a stale marker lingers until some unrelated render). Not fired for a still-STARTING
	 *   client (it published nothing) nor on `disposeAll` (deactivate -- panels are going away too).
	 */
	constructor(
		private readonly assertTrusted: () => void,
		private readonly clientFactory: (session: S) => ReactiveKernelClientLike,
		private readonly onClientRemoved?: (session: S) => void,
	) { }

	/** Start (or reuse) the kernel for `session`. Trust-gated; rejects loud if spawn/bootstrap fails. */
	async start(session: S): Promise<void> {
		this.assertTrusted();
		await this.ensure(session);
	}

	/** Execute one cell on `session`'s kernel (lazy-spawning it if needed). Trust-gated. */
	async executeCell(session: S, code: string): Promise<ReactiveOpResult> {
		this.assertTrusted();
		const client = await this.ensure(session);
		return client.execute(code);
	}

	/** Whether a live kernel is currently registered for `session`. */
	hasKernel(session: S): boolean {
		return this.clients.has(session);
	}

	/**
	 * W-G bound-cell indicator: the cells each published variable drives on (`session`, `sheet`), for a
	 * CellGridPanel to forward to its webview as badges. `[]` when no kernel is registered for the session
	 * (a grid with no reactive notebook, or one whose kernel is only still-starting and has published
	 * nothing yet) -- never throws, so the render path is unconditionally safe.
	 */
	publishedCellsForSheet(session: S, sheet: number): PublishedRange[] {
		const client = this.clients.get(session);
		return client === undefined ? [] : client.publishedCellsForSheet(sheet);
	}

	/**
	 * B1 MCP: EVERY published range for `session` with its target sheet id (incl. a now-deleted sheet),
	 * so `get_published_variables` enumerates the COMPLETE set rather than only the live-sheet cells.
	 * `[]` when no kernel is registered (a true empty -- the grid has no published variables).
	 */
	publishedCellsForAllSheets(session: S): Array<{ sheet: number; range: PublishedRange }> {
		const client = this.clients.get(session);
		return client === undefined ? [] : client.publishedCellsForAllSheets();
	}

	/** Dispose the kernel bound to `session` (no-op if none). Used on last-panel-close. Disposes a
	 *  STILL-STARTING kernel too (cancels the in-flight ensure so it tears down + does not register). */
	async disposeSession(session: S): Promise<void> {
		const starting = this.starting.get(session);
		if (starting !== undefined) {
			this.starting.delete(session); // signals ensure() that this start was cancelled
			await starting.client.dispose();
		}
		const client = this.clients.get(session);
		if (client !== undefined) {
			this.clients.delete(session);
			await client.dispose();
			// W-G: the store died with the client -> refresh the session's panels so orphaned badges clear.
			// (dispose() may fire the client's onClose, but the ensure() listener's `clients.get === client`
			// guard is already false here, so onClientRemoved fires exactly once -- from this call.)
			this.onClientRemoved?.(session);
		}
	}

	/** Dispose EVERY kernel -- registered AND still-starting -- awaited, so no ipykernel is orphaned
	 *  past extension deactivate. */
	async disposeAll(): Promise<void> {
		const all = [...this.clients.values(), ...[...this.starting.values()].map((e) => e.client)];
		this.clients.clear();
		this.starting.clear();
		await Promise.all(all.map((c) => c.dispose()));
	}

	// Lazy-spawn deduped against a concurrent start. A client that closes (crash or graceful) removes
	// itself via onClose, so the NEXT ensure() re-spawns -- "re-spawn on next use", not auto-respawn.
	// If disposal removes/replaces our `starting` entry mid-start, we tear the freshly-started kernel
	// down and DO NOT register it (No-Fallbacks: never leave an orphan bound to a closing Session).
	private async ensure(session: S): Promise<ReactiveKernelClientLike> {
		const existing = this.clients.get(session);
		if (existing !== undefined) {
			return existing;
		}
		const inflight = this.starting.get(session);
		if (inflight !== undefined) {
			return inflight.promise;
		}
		const client = this.clientFactory(session);
		let resolveStart!: (c: ReactiveKernelClientLike) => void;
		let rejectStart!: (e: unknown) => void;
		const promise = new Promise<ReactiveKernelClientLike>((res, rej) => {
			resolveStart = res;
			rejectStart = rej;
		});
		const entry = { client, promise };
		this.starting.set(session, entry);
		void (async (): Promise<void> => {
			try {
				client.onClose(() => {
					if (this.clients.get(session) === client) {
						this.clients.delete(session);
						// W-G: an UNEXPECTED close (crash/EOF) removed a live client -> refresh the session's
						// panels so orphaned bound-cell badges clear. The guard above ensures this does NOT
						// double-fire with disposeSession (which deletes first, so this branch is skipped then).
						this.onClientRemoved?.(session);
					}
				});
				await client.start();
				if (this.starting.get(session) !== entry) {
					// cancelled by disposeSession/disposeAll during startup
					await client.dispose();
					throw new Error('[kernel_disposed] reactive kernel start was cancelled by disposal');
				}
				this.clients.set(session, client);
				resolveStart(client);
			} catch (e) {
				rejectStart(e);
			} finally {
				if (this.starting.get(session) === entry) {
					this.starting.delete(session);
				}
			}
		})();
		return promise;
	}
}
