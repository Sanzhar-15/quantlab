/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Phase 5.7 V3.1.b (2026-05-22) -- multi-window IDE demo.
 *
 * Two (or more) VS Code windows each run `quantlab.quantbookDemoMultiWindow`.
 * The FIRST window's invocation spawns the V3.1.a relay binary as a child
 * process; SUBSEQUENT windows detect the already-running relay and skip
 * the spawn step. Each window opens its own `CollabSession` + attaches a
 * `WebSocketTransport` to ws://localhost:<port>; auto-flush + periodic
 * pollRemote drives cross-window propagation.
 *
 * Co-ordination model (chosen at V3.1.b design -- see V3 entry plan
 * `.plans/_active.md` section R6/R7/R8):
 * - **No env-var or shared-file role hand-off.** Each window's invocation
 *   is symmetric: try-connect-first, spawn-relay-only-if-needed. The
 *   first window to run the command happens to spawn the relay; the
 *   second window finds it already listening.
 * - **PeerId = `BigInt(process.pid)`** (Lane C R7). Each VS Code window
 *   has its own renderer process PID; collision is vanishingly rare.
 *   (Reserved PeerId 0 is rejected by the engine, but PIDs are positive.)
 * - **Relay readiness probe** (Lane C R6): after spawn, the parent waits
 *   for the binary's `[ql-collab-ws relay] listening on ws://...` stdout
 *   line before attempting to connect. Without this, racy connect-then-
 *   spawn-then-retry would leave the IDE in an inconsistent state.
 * - **Reconnect UX** (Lane C R2): catch `'transport_closed'` from
 *   `parseQuantbookError`; attempt up to 3 reconnects with 500ms /
 *   1000ms / 2000ms backoff before giving up.
 *
 * NOT in V3.1.b scope (deferred to V3.x):
 * - TLS, auth (localhost-only demo).
 * - Smarter reconnect policy (e.g., jitter, indefinite retry).
 * - Programmatic "spawn second window" -- the user opens a second window
 *   manually via `File > New Window` and runs the command again. A
 *   sub-command `quantlab.quantbookDemoMultiWindowOpenWindow` could
 *   automate this later.
 */

import * as childProcess from 'child_process';
import * as vscode from 'vscode';

import { resolveRelayBinaryPath } from './loader';
import { appendPutValueValidated, parseQuantbookError } from './session';
import type { CollabSessionInstance, QuantbookNativeModule } from './types';

/**
 * Localhost port the relay binary binds. Matches the binary's
 * `DEFAULT_PORT` constant (see `crates/ql-collab-ws/examples/relay-server.rs`).
 * Pinned here so the IDE's connect URL is stable across builds.
 */
const RELAY_PORT = 7117;

/** Connect URL the demo session uses. */
const RELAY_URL = `ws://127.0.0.1:${RELAY_PORT}`;

/** Periodic append cadence -- one PutValue every 2s. */
const APPEND_INTERVAL_MS = 2000;

/** Periodic poll cadence -- pollRemote every 1s. */
const POLL_INTERVAL_MS = 1000;

/** Max retries on transient transport_closed; backoff doubles each try. */
const MAX_RECONNECT_TRIES = 3;
const INITIAL_RECONNECT_BACKOFF_MS = 500;

/**
 * Defensive timeout for `spawnRelayBinary` readiness. V3.1.e audit
 * closure (Opus MEDIUM-1, 2026-05-22): bumped from 5s -> 10s to
 * tolerate Windows Defender real-time-scanning cold-spawn latency on
 * the first invocation after a fresh `cargo build`. macOS Gatekeeper
 * signing checks on a freshly-built binary can introduce similar
 * latency. The relay binary itself binds in <100ms under normal
 * conditions; the headroom is for first-spawn AV/notary overhead only.
 * Override via `QUANTBOOK_RELAY_SPAWN_TIMEOUT_MS` env var.
 */
const RELAY_SPAWN_TIMEOUT_MS = (() => {
	const env = process.env.QUANTBOOK_RELAY_SPAWN_TIMEOUT_MS;
	if (typeof env === 'string') {
		const n = Number.parseInt(env, 10);
		if (Number.isFinite(n) && n > 0) {
			return n;
		}
	}
	return 10000;
})();

/**
 * Spawn the `relay-server` binary as a child process and await its
 * "listening on" stdout marker before resolving. The relay's stable
 * marker line (committed in V3.1.a engine commit `9df01c5a050`) is
 * `[ql-collab-ws relay] listening on ws://127.0.0.1:<port>`.
 *
 * Lane C R6 closure: this readiness probe replaces the naive
 * connect-then-retry pattern with deterministic synchronization.
 *
 * Lifetime: the returned ChildProcess is owned by the caller. On
 * dispose, caller MUST call `.kill()` to terminate the relay; if the
 * IDE process exits without disposing, the OS reaps the child via
 * the spawned-with-detached:false default.
 */
async function spawnRelayBinary(
	log: vscode.OutputChannel,
	binaryPath: string,
): Promise<childProcess.ChildProcess> {
	log.appendLine(`[relay] spawning ${binaryPath} ...`);
	const child = childProcess.spawn(binaryPath, [], {
		env: { ...process.env, QL_RELAY_PORT: String(RELAY_PORT) },
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const readyMarker = '[ql-collab-ws relay] listening on';
	let resolved = false;

	return new Promise((resolve, reject) => {
		const onSpawnError = (err: Error): void => {
			if (resolved) {
				return;
			}
			resolved = true;
			reject(new Error(
				`[relay] failed to spawn ${binaryPath}: ${err.message}. ` +
				`Build the relay with: cd .../quantbook-engine && ` +
				`cargo build -p ql-collab-ws --example relay-server --release. ` +
				`Or set QUANTBOOK_RELAY_BINARY_PATH=<absolute path> to override.`,
			));
		};

		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			if (resolved) {
				return;
			}
			resolved = true;
			reject(new Error(
				`[relay] binary exited before readiness (code=${code}, signal=${signal}). ` +
				`Inspect the Output Channel for stderr.`,
			));
		};

		child.once('error', onSpawnError);
		child.once('exit', onExit);

		// Wait for the binary's "listening on" line on stdout.
		const stdout = child.stdout;
		if (stdout === null) {
			resolved = true;
			reject(new Error('[relay] spawned child has no stdout pipe'));
			return;
		}
		let buffer = '';
		stdout.setEncoding('utf8');
		stdout.on('data', (chunk: string) => {
			buffer += chunk;
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				log.appendLine(`[relay] ${line}`);
				if (!resolved && line.startsWith(readyMarker)) {
					resolved = true;
					child.off('error', onSpawnError);
					child.off('exit', onExit);
					resolve(child);
					return;
				}
			}
		});

		const stderr = child.stderr;
		if (stderr !== null) {
			stderr.setEncoding('utf8');
			stderr.on('data', (chunk: string) => {
				const trimmed = chunk.replace(/\n$/, '');
				if (trimmed.length > 0) {
					log.appendLine(`[relay stderr] ${trimmed}`);
				}
			});
		}

		// Defensive timeout in case the binary is hung. Bumped from 5s
		// to RELAY_SPAWN_TIMEOUT_MS (10s default) at V3.1.e Opus
		// MEDIUM-1 closure -- Windows Defender + macOS Gatekeeper on
		// first-spawn-of-freshly-built-binary can take multiple
		// seconds. Override via QUANTBOOK_RELAY_SPAWN_TIMEOUT_MS env
		// var. The V3.1.a binary itself binds in <100ms; the headroom
		// is for AV/notary overhead only.
		setTimeout(() => {
			if (!resolved) {
				resolved = true;
				try {
					child.kill();
				} catch { /* best-effort */ }
				reject(new Error(
					`[relay] did not emit readiness marker within ${RELAY_SPAWN_TIMEOUT_MS}ms. ` +
					`Expected stdout line: "${readyMarker} ws://127.0.0.1:${RELAY_PORT}". ` +
					`Bump via QUANTBOOK_RELAY_SPAWN_TIMEOUT_MS if Windows Defender or ` +
					`macOS Gatekeeper is causing slow first-spawn on a freshly-built binary.`,
				));
			}
		}, RELAY_SPAWN_TIMEOUT_MS);
	});
}

/**
 * Try to connect a WebSocket transport to the relay; if connect fails,
 * spawn the relay binary and retry.
 *
 * Returns the connected Transport AND (if the relay was spawned by this
 * call) the spawned ChildProcess so the caller can hold its lifetime.
 */
/**
 * V3.2.c.2 (2026-05-22): exported so the cell-grid collab command
 * (`quantlab.quantbookCellGridCollab`) can reuse the V3.1.b attach
 * orchestration verbatim per V3.2.c.1 decision C1 + C7.  Pre-V3.2.c
 * this function was private to multiWindowDemo.ts; visibility is now
 * widened but behaviour is byte-for-byte unchanged.
 */
export async function connectOrSpawn(
	engine: QuantbookNativeModule,
	log: vscode.OutputChannel,
): Promise<{
	transport: Awaited<ReturnType<typeof engine.Transport.websocketConnect>>;
	spawnedRelay: childProcess.ChildProcess | undefined;
}> {
	// First try: maybe another window is already running the relay.
	try {
		const transport = await engine.Transport.websocketConnect(RELAY_URL);
		log.appendLine(`[connect] joined existing relay at ${RELAY_URL}`);
		return { transport, spawnedRelay: undefined };
	} catch (firstErr) {
		const info = parseQuantbookError(firstErr);
		log.appendLine(
			`[connect] initial connect to ${RELAY_URL} failed ` +
			`(code=${info.code}); spawning relay binary...`,
		);
	}

	// Second try: spawn the relay, then connect.
	//
	// **V3.1.e audit closure (Opus MEDIUM-2 + Codex LOW-1 convergent,
	// 2026-05-22)**: two VS Code windows invoking the demo
	// concurrently both fail the initial connect (no relay up), both
	// call `spawnRelayBinary`. The OS gives the bind to one process;
	// the loser's binary exits with non-zero. Pre-V3.1.e the losing
	// window surfaced `[relay] binary exited before readiness` as a
	// FATAL, instead of joining the winning window's relay. Closure:
	// on `spawnRelayBinary` failure, retry the initial connect ONCE;
	// if it succeeds, treat this window as a joiner (spawnedRelay =
	// undefined -> dispose() will NOT try to kill another window's
	// relay).
	const binaryPath = resolveRelayBinaryPath();
	try {
		const spawnedRelay = await spawnRelayBinary(log, binaryPath);
		const transport = await engine.Transport.websocketConnect(RELAY_URL);
		log.appendLine(`[connect] spawned relay AND joined at ${RELAY_URL}`);
		return { transport, spawnedRelay };
	} catch (spawnErr) {
		const spawnDetail = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
		log.appendLine(`[connect] spawn failed (${spawnDetail}); race-retry initial connect...`);
		try {
			const transport = await engine.Transport.websocketConnect(RELAY_URL);
			log.appendLine(`[connect] joined relay spawned by another window (race-retry succeeded)`);
			return { transport, spawnedRelay: undefined };
		} catch (retryErr) {
			const retryInfo = parseQuantbookError(retryErr);
			log.appendLine(`[connect] race-retry connect also failed: code=${retryInfo.code} msg=${retryInfo.message}`);
			// Fall through to the original spawn error -- it's more
			// actionable than the connect error here (e.g., "build the
			// binary" vs. "connection refused").
			throw spawnErr;
		}
	}
}

/**
 * Best-effort reconnect path for transient transport_closed (Lane C R2).
 * Returns a fresh Transport, or throws if all retries are exhausted.
 *
 * NOTE: this does NOT respawn the relay binary -- if the relay process
 * itself died, the caller's spawn ownership remains intact (it'll see
 * the ChildProcess `exit` event separately) but reconnect attempts to
 * the same port will fail with `websocket_connect_failed`, which the
 * caller surfaces as a "Connection lost" notification.
 */
/**
 * V3.2.c.2 (2026-05-22): exported so the cell-grid collab command can
 * reuse the V3.1.c reconnect contract verbatim per V3.2.c.1 decision
 * C6.  Pre-V3.2.c this was private; visibility widened, behaviour
 * unchanged.  Future audit (V3.2.d) may decide to extract this +
 * connectOrSpawn into a dedicated `transportLifecycle.ts` module --
 * deferred per decision C7 to keep the V3.2.c diff small.
 */
export async function reconnectWithBackoff(
	engine: QuantbookNativeModule,
	log: vscode.OutputChannel,
): Promise<Awaited<ReturnType<typeof engine.Transport.websocketConnect>>> {
	let backoff = INITIAL_RECONNECT_BACKOFF_MS;
	for (let attempt = 1; attempt <= MAX_RECONNECT_TRIES; attempt += 1) {
		log.appendLine(`[reconnect] attempt ${attempt}/${MAX_RECONNECT_TRIES} after ${backoff}ms`);
		await new Promise(r => setTimeout(r, backoff));
		try {
			const t = await engine.Transport.websocketConnect(RELAY_URL);
			log.appendLine(`[reconnect] attempt ${attempt} succeeded`);
			return t;
		} catch (err) {
			const info = parseQuantbookError(err);
			log.appendLine(`[reconnect] attempt ${attempt} failed: code=${info.code}, msg=${info.message}`);
		}
		backoff *= 2;
	}
	throw new Error(
		`[reconnect] gave up after ${MAX_RECONNECT_TRIES} tries against ${RELAY_URL}. ` +
		`Restart the demo command or rebuild the relay binary.`,
	);
}

/**
 * Drive the multi-window demo for a single VS Code window. Returns a
 * Disposable; calling its `.dispose()` stops the timers + detaches the
 * transport + (if this window spawned the relay) kills the child
 * process. The caller (command registration) pushes the disposable to
 * the extension context's subscriptions so window-close cleans up.
 */
export async function runMultiWindowDemo(
	engine: QuantbookNativeModule,
	log: vscode.OutputChannel,
): Promise<vscode.Disposable> {
	const pid = process.pid;
	const peerId = BigInt(pid);
	log.appendLine('');
	log.appendLine('=== Quantbook Multi-Window Demo ===');
	log.appendLine(`window PID=${pid}, peerId=${peerId}`);
	log.appendLine(`relay URL: ${RELAY_URL}`);
	log.appendLine('');

	const { transport, spawnedRelay } = await connectOrSpawn(engine, log);

	const session: CollabSessionInstance = new engine.CollabSession(peerId);
	session.attachTransport(transport);
	session.setAutoFlushPolicy('onAppend');
	log.appendLine(`[session] created peerId=${peerId}; transport attached; auto-flush=onAppend`);

	// Distinguish multi-window edits by row -- use PID's low 16 bits
	// so two windows pick different rows reliably (PIDs differ by 1+
	// on the same OS, so low-16-bit collisions are vanishingly rare).
	const sheet = 0;
	const col = 0;
	const row = pid & 0xffff;
	log.appendLine(`[session] writing to sheet=${sheet}, row=${row} (= PID & 0xffff), col=${col}`);
	log.appendLine('');
	log.appendLine('To see two-window collaboration: open another VS Code window');
	log.appendLine('(File > New Window) and run "Quantbook: Demo (Multi-Window)" again.');
	log.appendLine('Both windows will share state via the relay.');
	log.appendLine('');

	let reconnectInFlight = false;
	let isDisposed = false;

	// Timer handles live inside a mutable container so `dispose` can
	// be defined BEFORE the timers are armed (the handler below
	// closes over `dispose` and may need to invoke it during reconnect
	// exhaustion). The container avoids `let` vars that eslint's
	// `prefer-const` flags as "never reassigned" (each handle is
	// assigned only once even though the binding shape requires
	// late initialization).
	const timers: {
		appendTimer?: NodeJS.Timeout;
		pollTimer?: NodeJS.Timeout;
	} = {};

	const dispose = (): void => {
		if (isDisposed) {
			return;
		}
		isDisposed = true;
		if (timers.appendTimer !== undefined) {
			clearInterval(timers.appendTimer);
		}
		if (timers.pollTimer !== undefined) {
			clearInterval(timers.pollTimer);
		}
		try {
			session.detachTransport();
		} catch { /* best-effort */ }
		// V3.1.e audit closure (Codex LOW-4, 2026-05-22): a child that
		// exited from a signal has `exitCode === null` AND
		// `signalCode !== null`. Checking only `exitCode` would attempt
		// to kill an already-signaled (dead) child. Also honour
		// `child.killed` for cleaner logging.
		if (
			spawnedRelay !== undefined &&
			spawnedRelay.exitCode === null &&
			spawnedRelay.signalCode === null &&
			!spawnedRelay.killed
		) {
			log.appendLine('[relay] killing spawned child process');
			try {
				spawnedRelay.kill();
			} catch { /* best-effort */ }
		}
		log.appendLine('[demo] disposed.');
	};

	const handleTransportClosed = async (label: string): Promise<void> => {
		if (reconnectInFlight || isDisposed) {
			return;
		}
		reconnectInFlight = true;
		log.appendLine(`[${label}] transport_closed -- attempting reconnect...`);
		try {
			session.detachTransport();
			const fresh = await reconnectWithBackoff(engine, log);
			if (isDisposed) {
				// Disposed while reconnect was in flight; drop the
				// newly-connected transport on the floor (its caller's
				// `attachTransport` would otherwise re-arm a session
				// we've already torn down).
				return;
			}
			session.attachTransport(fresh);
			log.appendLine(`[${label}] reconnect succeeded; demo resumes.`);
		} catch (err) {
			const info = parseQuantbookError(err);
			log.appendLine(`[${label}] reconnect EXHAUSTED: ${info.message}`);
			// Phase 5.7 V3.1.c (2026-05-22) -- Lane C R2 closure:
			// stop the demo cleanly on exhaustion BEFORE prompting the
			// user. Otherwise the timers keep ticking, re-triggering
			// handleTransportClosed, and the user sees stacked prompts.
			dispose();
			const choice = await vscode.window.showWarningMessage(
				`Quantbook multi-window demo connection lost: ${info.message}.`,
				'Restart Demo',
			);
			if (choice === 'Restart Demo') {
				// Re-invoke the same command. The fresh invocation will
				// see the relay process is dead (this window owned it)
				// and re-spawn via connectOrSpawn's spawn fallback.
				void vscode.commands.executeCommand('quantlab.quantbookDemoMultiWindow');
			}
		} finally {
			reconnectInFlight = false;
		}
	};

	timers.appendTimer = setInterval(() => {
		if (reconnectInFlight || isDisposed) {
			return;
		}
		try {
			const value = Date.now() / 1000;
			appendPutValueValidated(session, sheet, row, col, value);
			log.appendLine(`[append] PutValue(s=${sheet}, r=${row}, c=${col}, v=${value.toFixed(3)}) -> opCount=${session.opCount()}`);
		} catch (err) {
			const info = parseQuantbookError(err);
			log.appendLine(`[append] ERROR code=${info.code} msg=${info.message}`);
			if (info.code === 'transport_closed' || info.code === 'transport_io') {
				void handleTransportClosed('append');
			}
		}
	}, APPEND_INTERVAL_MS);

	timers.pollTimer = setInterval(() => {
		if (reconnectInFlight || isDisposed) {
			return;
		}
		try {
			const merged = session.pollRemote();
			if (merged > 0) {
				log.appendLine(`[poll] pollRemote() merged ${merged} blob(s) -> opCount=${session.opCount()}`);
			}
		} catch (err) {
			const info = parseQuantbookError(err);
			log.appendLine(`[poll] ERROR code=${info.code} msg=${info.message}`);
			if (info.code === 'transport_closed' || info.code === 'transport_io') {
				void handleTransportClosed('poll');
			}
		}
	}, POLL_INTERVAL_MS);

	if (spawnedRelay !== undefined) {
		spawnedRelay.on('exit', (code, signal) => {
			log.appendLine(`[relay] child process exited (code=${code}, signal=${signal})`);
		});
	}

	return new vscode.Disposable(dispose);
}
