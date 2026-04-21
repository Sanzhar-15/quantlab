/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Mock Quantlab Cloud server for integration testing.
 * Speaks the QIC canonical protocol — accepts requests, returns canned StreamChunk responses.
 *
 * Usage:
 *   const server = new MockCloudServer();
 *   await server.start(3001);
 *   // ... run tests against http://localhost:3001 ...
 *   await server.stop();
 */

import * as http from 'http';

export interface MockCloudServerOptions {
	/** JWT signing secret for token validation (default: 'test-secret') */
	jwtSecret?: string;
	/** Simulate rate limiting after N requests (default: disabled) */
	rateLimitAfter?: number;
	/** Simulate latency in ms (default: 0) */
	latencyMs?: number;
	/** Force error status code for all requests */
	forceErrorStatus?: number;
}

interface MockServerState {
	requestCount: number;
	lastRequest: unknown | null;
	lastHeaders: Record<string, string>;
}

const DEFAULT_CANNED_RESPONSE = {
	content: [{ type: 'text', text: 'Hello from mock Quantlab Cloud!' }],
	usage: { inputTokens: 10, outputTokens: 5 },
	stopReason: 'end_turn',
};

const DEFAULT_ROUTING_EVENT = {
	type: 'routing',
	actualModel: 'claude-sonnet-4-20250514',
	tier: 'pro',
	estimatedTtft: 150,
};

export class MockCloudServer {
	private server: http.Server | null = null;
	private readonly state: MockServerState = {
		requestCount: 0,
		lastRequest: null,
		lastHeaders: {},
	};
	private options: MockCloudServerOptions;

	constructor(options: MockCloudServerOptions = {}) {
		this.options = options;
	}

	async start(port: number = 3001): Promise<void> {
		return new Promise((resolve, reject) => {
			this.server = http.createServer((req, res) => this.handleRequest(req, res));
			this.server.on('error', reject);
			this.server.listen(port, () => resolve());
		});
	}

	async stop(): Promise<void> {
		return new Promise((resolve) => {
			if (this.server) {
				this.server.close(() => resolve());
			} else {
				resolve();
			}
		});
	}

	getState(): MockServerState {
		return { ...this.state };
	}

	resetState(): void {
		this.state.requestCount = 0;
		this.state.lastRequest = null;
		this.state.lastHeaders = {};
	}

	private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		this.state.requestCount++;
		this.state.lastHeaders = (req.headers as Record<string, string>) ?? {};

		const delay = this.options.latencyMs ?? 0;
		setTimeout(() => this.routeRequest(req, res), delay);
	}

	private routeRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
		const url = req.url ?? '';
		const method = req.method ?? 'GET';

		// Validate JWT token
		const authHeader = req.headers.authorization;
		if (authHeader && !url.includes('/auth/')) {
			const token = authHeader.replace('Bearer ', '');
			if (!this.validateToken(token)) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Invalid token' }));
				return;
			}
		}

		// Check rate limit
		if (this.options.rateLimitAfter && this.state.requestCount > this.options.rateLimitAfter) {
			res.writeHead(429, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Rate limited', retry_after: 60 }));
			return;
		}

		// Force error
		if (this.options.forceErrorStatus) {
			res.writeHead(this.options.forceErrorStatus, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: `Forced error ${this.options.forceErrorStatus}` }));
			return;
		}

		// Route
		if (url === '/v1/health' && method === 'GET') {
			this.handleHealth(res);
		} else if (url === '/v1/qic/request' && method === 'POST') {
			this.collectBody(req, (body) => this.handleRequest2(body, req, res));
		} else if (url === '/v1/qic/stream' && method === 'POST') {
			this.collectBody(req, (body) => this.handleStream(body, req, res));
		} else if (url === '/v1/auth/token' && method === 'POST') {
			this.collectBody(req, (body) => this.handleTokenExchange(body, res));
		} else if (url === '/v1/auth/refresh' && method === 'POST') {
			this.handleTokenRefresh(res);
		} else if (url === '/v1/auth/revoke' && method === 'POST') {
			res.writeHead(200);
			res.end();
		} else {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Not found' }));
		}
	}

	private handleHealth(res: http.ServerResponse): void {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ status: 'healthy' }));
	}

	private handleRequest2(body: string, req: http.IncomingMessage, res: http.ServerResponse): void {
		try {
			this.state.lastRequest = JSON.parse(body);
		} catch { /* ignore */ }

		// Check X-QIC-Token-Refresh trigger
		const headers: Record<string, string> = { 'Content-Type': 'application/json' };
		if (this.state.requestCount > 5) {
			headers['X-QIC-Token-Refresh'] = 'required';
		}

		res.writeHead(200, headers);
		res.end(JSON.stringify(DEFAULT_CANNED_RESPONSE));
	}

	private handleStream(body: string, req: http.IncomingMessage, res: http.ServerResponse): void {
		try {
			this.state.lastRequest = JSON.parse(body);
		} catch { /* ignore */ }

		res.writeHead(200, {
			'Content-Type': 'text/event-stream',
			'Cache-Control': 'no-cache',
			'Connection': 'keep-alive',
		});

		// Send routing event first
		res.write(`data: ${JSON.stringify(DEFAULT_ROUTING_EVENT)}\n\n`);

		// Send text chunks
		const words = ['Hello', ' from', ' mock', ' cloud', '!'];
		let i = 0;
		const interval = setInterval(() => {
			if (i < words.length) {
				res.write(`data: ${JSON.stringify({ type: 'text', text: words[i] })}\n\n`);
				i++;
			} else {
				clearInterval(interval);
				// Send done event
				res.write(`data: ${JSON.stringify({
					type: 'done',
					usage: { inputTokens: 10, outputTokens: words.length },
					stopReason: 'end_turn',
					meta: { quotaRemaining: { requests: 95 } },
				})}\n\n`);
				res.write('data: [DONE]\n\n');
				res.end();
			}
		}, 10);
	}

	private handleTokenExchange(body: string, res: http.ServerResponse): void {
		let parsed: Record<string, string> = {};
		try {
			parsed = Object.fromEntries(new URLSearchParams(body));
		} catch { /* ignore */ }

		if (!parsed.code || !parsed.code_verifier) {
			res.writeHead(400, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ error: 'Missing code or code_verifier' }));
			return;
		}

		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			access_token: 'test-access-token-' + Date.now(),
			refresh_token: 'test-refresh-token-' + Date.now(),
			expires_in: 3600,
			scope: 'qic:inference qic:usage',
		}));
	}

	private handleTokenRefresh(res: http.ServerResponse): void {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({
			access_token: 'refreshed-access-token-' + Date.now(),
			refresh_token: 'refreshed-refresh-token-' + Date.now(),
		}));
	}

	private validateToken(token: string): boolean {
		// Simple validation: token must be non-empty and not 'invalid'
		return token.length > 0 && token !== 'invalid';
	}

	private collectBody(req: http.IncomingMessage, callback: (body: string) => void): void {
		let body = '';
		req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
		req.on('end', () => callback(body));
	}
}
