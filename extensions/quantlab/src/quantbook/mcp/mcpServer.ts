/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-BEYOND B1 -- the VS Code host shell for the read-only Quantbook MCP server.
//
// Runs an MCP server IN the extension host so its tools read the SAME live per-panel napi `Session`
// the grid renders -- that shared-state requirement is why this is in-host and NOT the separate
// ql-service HTTP engine (which does not see the live in-host workbook). It is the thin adapter over
// the vscode-free tool layer (mcpToolLogic.ts): it resolves the live grids FRESH on every tool call
// via the CellGridPanel accessors + the reactive kernel manager, and wires the official
// @modelcontextprotocol/sdk over a localhost Streamable-HTTP transport.
//
// Transport: localhost (127.0.0.1) Streamable HTTP in STATELESS JSON mode -- a fresh McpServer +
// StreamableHTTPServerTransport per POST, torn down on response close. Stateless suits a read-only,
// no-subscription tool surface and keeps zero cross-request state (the isolation the brief calls for;
// MCP is kept off the panel's single delta cursor for performance + isolation, reading via the shared
// snapshot/queryRange cache instead).
//
// ESM/CJS seam: the SDK is ESM-only and this extension compiles to CommonJS. It is loaded via a
// dynamic import() that TypeScript must NOT down-compile to require() -- the `new Function('s','return
// import(s)')` hatch preserves a real ESM import at runtime (verified on the Node 22 host). zod (v3)
// builds the tool input schemas.
//
// No-Fallbacks: a tool whose pure handler throws (no grid / ambiguous grid / unknown sheet / bad A1 /
// snapshot over cap) returns an MCP in-band error result (isError) carrying the thrown message
// verbatim -- the agent SEES the failure; nothing is masked or defaulted. A bind/listen failure on
// start rejects loud.

import { randomBytes, timingSafeEqual } from 'node:crypto';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import * as vscode from 'vscode';

import { CellGridPanel } from '../cellGrid/cellGridPanel';
import type { ReactiveKernelManager } from '../reactiveKernel/reactiveKernelManager';
import type { SessionInstance } from '../types';
import {
	McpToolError,
	toolGetCell,
	toolGetPublishedVariables,
	toolGetSnapshot,
	toolListFunctions,
	toolListSheets,
	toolQueryRange,
	type McpHostContext,
	type McpSessionPort,
	type McpTargetGrid,
	type PublishedVariableTargets,
} from './mcpToolLogic';

// The ESM-import hatch: a Function-constructed dynamic import so the TypeScript CommonJS emit does NOT
// rewrite it to require() (which would throw on the ESM-only SDK). Resolves bare specifiers relative to
// this compiled module, so the package-root node_modules is found. The Function ctor is the documented,
// intentional CJS->ESM bridge here (not arbitrary code-eval); the argument is a fixed literal.
const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

// Minimal structural types for the dynamically-imported SDK surface (we cannot `import type` from an
// ESM-only package under CommonJS module resolution without NodeNext; these mirror the verified v1.29
// .d.ts shapes we use).
interface McpToolContent {
	content: { type: 'text'; text: string }[];
	isError?: boolean;
}
interface McpServerLike {
	registerTool(
		name: string,
		config: { title?: string; description?: string; inputSchema?: Record<string, unknown> },
		cb: (args: Record<string, unknown>) => McpToolContent | Promise<McpToolContent>,
	): unknown;
	connect(transport: unknown): Promise<void>;
	close(): Promise<void>;
}
interface McpServerCtor {
	new(info: { name: string; version: string }): McpServerLike;
}
interface StreamableTransportLike {
	handleRequest(req: http.IncomingMessage, res: http.ServerResponse, parsedBody?: unknown): Promise<void>;
	close(): Promise<void>;
}
interface StreamableTransportCtor {
	new(options: { sessionIdGenerator: undefined; enableJsonResponse: boolean }): StreamableTransportLike;
}
/** A chainable zod schema stub: the subset of the builder API the tool schemas use. */
interface ZodSchemaLike {
	optional(): ZodSchemaLike;
	describe(description: string): ZodSchemaLike;
}
interface ZodLike {
	string(): ZodSchemaLike;
	number(): ZodSchemaLike;
	union(options: ZodSchemaLike[]): ZodSchemaLike;
}

interface LoadedSdk {
	McpServer: McpServerCtor;
	StreamableHTTPServerTransport: StreamableTransportCtor;
	z: ZodLike;
}

let sdkPromise: Promise<LoadedSdk> | undefined;
/** Load (once, memoized) the ESM-only SDK + zod. A failure here is fatal to THIS start attempt, but the
 *  memoized promise is CLEARED on failure (Codex LOW) so a later Start retries the load rather than
 *  replaying a permanently-rejected promise. The memoization holds only a SUCCESSFUL load. */
async function loadSdk(): Promise<LoadedSdk> {
	if (sdkPromise === undefined) {
		sdkPromise = (async (): Promise<LoadedSdk> => {
			const mcpMod = (await importEsm('@modelcontextprotocol/sdk/server/mcp.js')) as { McpServer: McpServerCtor };
			const trMod = (await importEsm('@modelcontextprotocol/sdk/server/streamableHttp.js')) as { StreamableHTTPServerTransport: StreamableTransportCtor };
			const zodMod = (await importEsm('zod')) as { z?: ZodLike; default?: ZodLike };
			const z = zodMod.z ?? zodMod.default;
			if (z === undefined) {
				throw new Error('[mcp_sdk_load] zod did not export a usable `z` -- check the installed zod version (v3 expected)');
			}
			return { McpServer: mcpMod.McpServer, StreamableHTTPServerTransport: trMod.StreamableHTTPServerTransport, z };
		})();
		sdkPromise.catch(() => {
			sdkPromise = undefined;
		});
	}
	return sdkPromise;
}

/** The MCP server binds to loopback only -- it must never be reachable off-host. */
const MCP_HOST = '127.0.0.1';
/** The HTTP path the MCP endpoint serves. */
const MCP_PATH = '/mcp';

/**
 * STABLE per-Session id assignment (Codex HIGH fold). A grid id MUST identify the SAME workbook for the
 * life of the host, never recycling a closed session's number onto a new one -- else a client reusing a
 * stale `sessionId` would silently read a DIFFERENT workbook (a No-Fallbacks "silent retarget"). The id
 * is derived from the napi Session IDENTITY via a WeakMap + a monotonic counter that never reuses a
 * value; the WeakMap lets a closed Session's entry be GC'd without ever re-minting its ordinal.
 */
const sessionIdByInstance = new WeakMap<SessionInstance, number>();
let nextSessionOrdinal = 0;
function stableSessionOrdinal(session: SessionInstance): number {
	let ordinal = sessionIdByInstance.get(session);
	if (ordinal === undefined) {
		ordinal = nextSessionOrdinal++;
		sessionIdByInstance.set(session, ordinal);
	}
	return ordinal;
}

/**
 * Build the per-call host context from the LIVE CellGridPanel registry + the reactive kernel manager.
 * Resolved fresh on every tool invocation (panels open/close between calls). The grid `id` is a
 * monotonic per-Session ordinal (never recycled -- see {@link stableSessionOrdinal}) plus the sheet, so
 * two workbooks showing the same sheet get distinct ids and a stale id never resolves to a new workbook.
 */
function buildHostContext(kernelManager: ReactiveKernelManager<SessionInstance>): McpHostContext {
	const panels = CellGridPanel.activeLocalPanels();
	const grids: McpTargetGrid[] = panels.map((p) => ({
		id: `grid-${stableSessionOrdinal(p.session)}-sheet-${p.sheet}`,
		session: p.session as McpSessionPort,
		sheet: p.sheet,
	}));
	const focused = CellGridPanel.focusedLocalPanel();
	let focusedId: string | undefined;
	if (focused !== undefined) {
		const match = grids.find((g) => g.session === (focused.session as McpSessionPort) && g.sheet === focused.sheet);
		focusedId = match?.id;
	}
	// Map the McpSessionPort back to the real SessionInstance to query the kernel manager. The port IS
	// the SessionInstance (structural), so the identity match holds.
	const portToSession = new Map<McpSessionPort, SessionInstance>(panels.map((p) => [p.session as McpSessionPort, p.session]));
	return {
		grids,
		focusedId,
		publishedVariables(session: McpSessionPort): PublishedVariableTargets[] {
			const real = portToSession.get(session);
			if (real === undefined) {
				return [];
			}
			// Enumerate the COMPLETE published set (every sheet, incl. a now-deleted one -- Codex MED:
			// the prior per-live-sheet walk silently dropped a variable on a tombstoned sheet, which the
			// pure formatter's #REF! path then never saw). The accessor carries each range's sheet id.
			return kernelManager.publishedCellsForAllSheets(real).map((e) => ({
				name: e.range.name,
				range: { sheet: e.sheet, startRow: e.range.startRow, startCol: e.range.startCol, endRow: e.range.endRow, endCol: e.range.endCol },
			}));
		},
	};
}

/** Wrap a pure tool handler: run it, JSON-serialize the result, convert a thrown error to an MCP
 *  in-band error result (isError) carrying the message verbatim (No-Fallbacks -- the agent sees it). */
function runTool<A>(handler: (ctx: McpHostContext, args: A) => unknown, ctx: McpHostContext, args: A): McpToolContent {
	try {
		const result = handler(ctx, args);
		return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
	} catch (err) {
		const message = err instanceof McpToolError ? err.message : err instanceof Error ? err.message : String(err);
		return { content: [{ type: 'text', text: message }], isError: true };
	}
}

/** Register the six read-only tools on a fresh McpServer, each resolving the live host context on call. */
function registerReadOnlyTools(server: McpServerLike, sdk: LoadedSdk, kernelManager: ReactiveKernelManager<SessionInstance>): void {
	const { z } = sdk;
	const sessionIdArg = { sessionId: z.string().describe('Optional Cell Grid id to target when several are open (from a prior tool result).').optional() };
	const ctx = (): McpHostContext => buildHostContext(kernelManager);

	server.registerTool(
		'list_sheets',
		{ title: 'List sheets', description: 'List the live sheets (id + name) of the focused (or named) Quantbook Cell Grid workbook.', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolListSheets, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'get_cell',
		{
			title: 'Get cell',
			description: 'Read one cell by A1 reference. Address it sheet-qualified ("S0!B1") or pass a separate sheet arg; with neither, the grid\'s focused sheet is used. Returns value, formula, and rendered display string (any may be absent for an empty cell).',
			inputSchema: { a1: z.string().describe('The A1 cell, e.g. "B1" or sheet-qualified "S0!B1".'), sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id (ignored if the A1 is sheet-qualified).').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolGetCell, ctx(), args as { sessionId?: string; a1: string; sheet?: number | string }),
	);

	server.registerTool(
		'query_range',
		{
			title: 'Query range (primary read)',
			description: 'Read a rectangular range as columnar values -- the PRIMARY, efficient read. Range is sheet-qualified ("S0!B1:D3") or bare with a sheet arg. Returns nRows, nCols, and column-major values. Prefer this over get_snapshot.',
			inputSchema: { range: z.string().describe('The A1 range, e.g. "S0!B1:D3" (sheet-qualified) or "B1:D3" with a sheet arg.'), sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id (ignored if the range is sheet-qualified).').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolQueryRange, ctx(), args as { sessionId?: string; range: string; sheet?: number | string }),
	);

	server.registerTool(
		'get_snapshot',
		{
			title: 'Get snapshot (capped)',
			description: 'Read the full workbook (or one sheet) as snapshot cells. CAPPED -- a workbook over the cell cap fails loud; use query_range for large or 1M-cell sheets. Optionally scope to one sheet.',
			inputSchema: { sheet: z.union([z.string(), z.number()]).describe('Optional sheet name or id to scope the snapshot to a single sheet.').optional(), ...sessionIdArg },
		},
		(args) => runTool(toolGetSnapshot, ctx(), args as { sessionId?: string; sheet?: number | string }),
	);

	server.registerTool(
		'list_functions',
		{ title: 'List functions', description: 'List every registered engine function and user-defined function (canonical name, arity, volatility, ...), sorted by name.', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolListFunctions, ctx(), args as { sessionId?: string }),
	);

	server.registerTool(
		'get_published_variables',
		{ title: 'Get published variables', description: 'List the reactive-kernel variables currently published into the grid and the A1 cells each drives (empty if no reactive notebook is bound).', inputSchema: { ...sessionIdArg } },
		(args) => runTool(toolGetPublishedVariables, ctx(), args as { sessionId?: string }),
	);
}

/**
 * A running MCP HTTP server instance. Closing it stops the listener and is idempotent.
 */
interface RunningMcpServer {
	readonly url: string;
	readonly port: number;
	/** The per-start bearer token every request must present (`Authorization: Bearer <token>`). */
	readonly token: string;
	close(): Promise<void>;
}

/** Max request body the server will buffer. The MCP JSON-RPC payloads are tiny (a tool call is a few
 *  hundred bytes); cap well above that and reject larger bodies loud (Codex LOW: no unbounded buffer). */
const MAX_REQUEST_BODY_BYTES = 1 << 20; // 1 MiB

/**
 * Start the localhost MCP HTTP server. Stateless: each POST gets a fresh McpServer + transport,
 * connected, handled, and torn down on response close. `port: 0` lets the OS pick a free port (the
 * resolved URL is returned + logged). Mints a per-start random bearer `token` REQUIRED on every request
 * (Codex HIGH: a localhost port is otherwise readable by any local process -- the token gates access to
 * live, possibly-unsaved workbook data). Rejects loud on a bind/listen failure (No-Fallbacks).
 */
async function startMcpHttpServer(
	kernelManager: ReactiveKernelManager<SessionInstance>,
	output: vscode.OutputChannel,
	port: number,
): Promise<RunningMcpServer> {
	const sdk = await loadSdk();
	const token = randomBytes(32).toString('hex');
	const httpServer = http.createServer((req, res) => {
		void handleHttpRequest(req, res, sdk, kernelManager, output, token);
	});
	await new Promise<void>((resolve, reject) => {
		const onError = (err: Error): void => {
			reject(new Error(`[mcp_listen_failed] could not bind ${MCP_HOST}:${port}: ${err.message}`));
		};
		httpServer.once('error', onError);
		httpServer.listen(port, MCP_HOST, () => {
			httpServer.removeListener('error', onError);
			resolve();
		});
	});
	const address = httpServer.address() as AddressInfo;
	const resolvedPort = address.port;
	const url = `http://${MCP_HOST}:${resolvedPort}${MCP_PATH}`;
	return {
		url,
		port: resolvedPort,
		token,
		close: (): Promise<void> => new Promise<void>((resolve) => {
			httpServer.close(() => resolve());
		}),
	};
}

/** Per-request handler: validate Host + method + path + bearer token, parse the JSON body (size-capped),
 *  drive a fresh stateless McpServer/transport, and tear it down when the response closes. */
async function handleHttpRequest(
	req: http.IncomingMessage,
	res: http.ServerResponse,
	sdk: LoadedSdk,
	kernelManager: ReactiveKernelManager<SessionInstance>,
	output: vscode.OutputChannel,
	token: string,
): Promise<void> {
	// Loopback + Host-header guard: the StreamableHTTP DNS-rebinding option is deprecated in favor of
	// external middleware, so we enforce it here -- reject any request whose Host header is not a
	// loopback literal. This defends a browser-based DNS-rebinding attack against a localhost server.
	if (!isLoopbackHost(req.headers.host)) {
		res.writeHead(403, { 'content-type': 'text/plain' }).end('forbidden: non-loopback Host header');
		return;
	}
	// Bearer-token auth (Codex HIGH): any local process can reach the loopback port, so require the
	// per-start token. Constant-time compare so a wrong token cannot be timing-probed.
	if (!hasValidBearerToken(req.headers.authorization, token)) {
		res.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' }).end('unauthorized: missing or invalid bearer token');
		return;
	}
	// POST-only (Codex MED): the stateless JSON contract is POST. Reject GET/DELETE so a client cannot
	// open a long-lived SSE stream / session-delete against a server that holds none.
	if (req.method !== 'POST') {
		res.writeHead(405, { 'content-type': 'text/plain', allow: 'POST' }).end('method not allowed: POST only');
		return;
	}
	const url = req.url ?? '';
	const pathOnly = url.split('?')[0];
	if (pathOnly !== MCP_PATH) {
		res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
		return;
	}
	let body: string | undefined;
	try {
		body = await readBodyCapped(req);
	} catch (err) {
		// A stream error or an over-cap body is a loud reject (Codex LOW: do NOT resolve as if the
		// request ended normally; do NOT buffer unbounded). Send the status, then destroy the (paused)
		// request so the rest of the oversize upload is not read.
		const tooLarge = err instanceof Error && err.message === 'body_too_large';
		if (!res.headersSent) {
			res.writeHead(tooLarge ? 413 : 400, { 'content-type': 'text/plain' }).end(tooLarge ? 'payload too large' : 'bad request: stream error');
		}
		req.destroy();
		return;
	}
	let parsedBody: unknown;
	if (body.length > 0) {
		try {
			parsedBody = JSON.parse(body);
		} catch {
			res.writeHead(400, { 'content-type': 'text/plain' }).end('bad request: malformed JSON body');
			return;
		}
	}
	const server = new sdk.McpServer({ name: 'quantbook-mcp', version: '0.1.0' });
	registerReadOnlyTools(server, sdk, kernelManager);
	const transport = new sdk.StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
	const teardown = (): void => {
		void transport.close();
		void server.close();
	};
	res.on('close', teardown);
	try {
		await server.connect(transport);
		await transport.handleRequest(req, res, parsedBody);
	} catch (err) {
		output.appendLine(`[mcp] request handling failed: ${err instanceof Error ? err.message : String(err)}`);
		if (!res.headersSent) {
			res.writeHead(500, { 'content-type': 'text/plain' }).end('internal error');
		}
		teardown();
	}
}

/** Read the request body as a string, rejecting (loud) over {@link MAX_REQUEST_BODY_BYTES} or on a
 *  stream error -- never resolving as if a truncated/errored stream ended normally. */
function readBodyCapped(req: http.IncomingMessage): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		const chunks: Buffer[] = [];
		let size = 0;
		req.on('data', (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_REQUEST_BODY_BYTES) {
				// Stop reading + reject; the handler sends the 413 THEN destroys the request (so the
				// status line reaches the client before the socket tears down).
				req.pause();
				reject(new Error('body_too_large'));
				return;
			}
			chunks.push(chunk);
		});
		req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
		req.on('error', (err) => reject(err));
	});
}

/** Constant-time check that the Authorization header carries the expected `Bearer <token>`. */
function hasValidBearerToken(authorization: string | undefined, token: string): boolean {
	if (authorization === undefined) {
		return false;
	}
	const match = /^Bearer\s+(.+)$/.exec(authorization);
	if (match === null) {
		return false;
	}
	const presented = Buffer.from(match[1], 'utf8');
	const expected = Buffer.from(token, 'utf8');
	if (presented.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(presented, expected);
}

/** Whether a Host header names a loopback address (no DNS-rebinding host). Accepts an optional :port. */
function isLoopbackHost(host: string | undefined): boolean {
	if (host === undefined) {
		return false;
	}
	const hostname = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
}

/**
 * Register the `quantlab.quantbookStartMcpServer` command + a lifecycle disposable. Idempotent: a second
 * Start restarts the server (closing the prior one first). The disposable stops the server on
 * deactivate. The kernel manager is captured so get_published_variables can read the live publish state.
 */
export function registerQuantbookMcpServer(
	context: vscode.ExtensionContext,
	kernelManager: ReactiveKernelManager<SessionInstance>,
): void {
	const output = vscode.window.createOutputChannel('Quantbook MCP Server');
	context.subscriptions.push(output);

	let running: RunningMcpServer | undefined;
	const stop = async (): Promise<void> => {
		if (running !== undefined) {
			const toClose = running;
			running = undefined;
			await toClose.close();
			output.appendLine('[mcp] server stopped.');
		}
	};
	// The lifecycle disposable: close the listener on deactivate (No-Fallbacks -- no orphaned socket).
	context.subscriptions.push({ dispose: () => void stop() });

	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.quantbookStartMcpServer', async () => {
			try {
				await stop();
				// Default to an OS-picked free port; the operator can pin one via quantlab.quantbookMcpPort.
				const configuredPort = vscode.workspace.getConfiguration('quantlab').get<number>('quantbookMcpPort');
				const port = typeof configuredPort === 'number' && Number.isInteger(configuredPort) && configuredPort >= 0 ? configuredPort : 0;
				running = await startMcpHttpServer(kernelManager, output, port);
				output.appendLine(`[mcp] read-only Quantbook MCP server listening at ${running.url}`);
				output.appendLine('[mcp] connect an MCP client over Streamable HTTP (stateless JSON). EVERY request must send the bearer token below.');
				output.appendLine(`[mcp]   URL:    ${running.url}`);
				output.appendLine(`[mcp]   Header: Authorization: Bearer ${running.token}`);
				output.appendLine('[mcp] tools: list_sheets, get_cell, query_range, get_snapshot, list_functions, get_published_variables.');
				output.show(true);
				const action = await vscode.window.showInformationMessage(
					`Quantbook MCP server running at ${running.url} (bearer token printed to the Quantbook MCP Server output).`,
					'Copy URL',
					'Copy Token',
				);
				if (running !== undefined) {
					if (action === 'Copy URL') {
						await vscode.env.clipboard.writeText(running.url);
					} else if (action === 'Copy Token') {
						await vscode.env.clipboard.writeText(running.token);
					}
				}
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				output.appendLine(`[mcp] start failed: ${message}`);
				void vscode.window.showErrorMessage(`Quantbook MCP server failed to start: ${message}`);
			}
		}),
	);
}
