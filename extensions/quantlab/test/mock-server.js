#!/usr/bin/env node
/**
 * Mock Delta Plus Server for testing QuantLab integration.
 * Run with: node mock-server.js
 */

const http = require('http');

// Optional WebSocket support
let WebSocketServer;
try {
	WebSocketServer = require('ws').WebSocketServer;
} catch {
	console.log('Note: ws module not found, WebSocket disabled');
}

const PORT = 8080;

// Mock data
const SYMBOLS = [
	{ symbol: 'AAPL', name: 'Apple Inc.', sector: 'Tech', base_price: 175.50, tradeable: true },
	{ symbol: 'GOOGL', name: 'Alphabet Inc.', sector: 'Tech', base_price: 140.25, tradeable: true },
	{ symbol: 'MSFT', name: 'Microsoft Corp.', sector: 'Tech', base_price: 380.00, tradeable: true },
	{ symbol: 'JPM', name: 'JPMorgan Chase', sector: 'Finance', base_price: 195.00, tradeable: true },
	{ symbol: 'GS', name: 'Goldman Sachs', sector: 'Finance', base_price: 450.00, tradeable: true },
	{ symbol: 'JNJ', name: 'Johnson & Johnson', sector: 'Healthcare', base_price: 155.00, tradeable: true },
	{ symbol: 'PFE', name: 'Pfizer Inc.', sector: 'Healthcare', base_price: 28.50, tradeable: true },
	{ symbol: 'XOM', name: 'Exxon Mobil', sector: 'Energy', base_price: 105.00, tradeable: true },
	{ symbol: 'BTC', name: 'Bitcoin', sector: 'Crypto', base_price: 67000.00, tradeable: true },
	{ symbol: 'ETH', name: 'Ethereum', sector: 'Crypto', base_price: 3500.00, tradeable: true },
];

const WATCHLISTS = [
	{ id: 'wl-1', name: 'Tech Stocks', symbols: ['AAPL', 'GOOGL', 'MSFT'], is_default: true, sort_order: 0 },
	{ id: 'wl-2', name: 'Crypto', symbols: ['BTC', 'ETH'], is_default: false, sort_order: 1 },
];

let tokens = new Map();
let tokenCounter = 0;

function generateToken() {
	return `mock-token-${++tokenCounter}-${Date.now()}`;
}

function generateBars(symbol, timeframe, limit = 100) {
	const bars = [];
	const now = Date.now();
	const baseSymbol = SYMBOLS.find(s => s.symbol === symbol);
	const basePrice = baseSymbol?.base_price || 100;

	const intervals = {
		'1m': 60 * 1000,
		'5m': 5 * 60 * 1000,
		'15m': 15 * 60 * 1000,
		'30m': 30 * 60 * 1000,
		'1h': 60 * 60 * 1000,
		'4h': 4 * 60 * 60 * 1000,
		'1D': 24 * 60 * 60 * 1000,
	};

	const interval = intervals[timeframe] || intervals['1D'];
	let price = basePrice;

	for (let i = limit - 1; i >= 0; i--) {
		const timestamp = new Date(now - i * interval).toISOString();
		const change = (Math.random() - 0.5) * price * 0.02;
		const open = price;
		price = Math.max(1, price + change);
		const close = price;
		const high = Math.max(open, close) * (1 + Math.random() * 0.01);
		const low = Math.min(open, close) * (1 - Math.random() * 0.01);
		const volume = Math.floor(Math.random() * 1000000) + 100000;

		bars.push({ symbol, timestamp, open, high, low, close, volume });
	}

	return bars;
}

function handleRequest(req, res) {
	const url = new URL(req.url, `http://localhost:${PORT}`);
	const path = url.pathname;
	const method = req.method;

	// CORS headers
	res.setHeader('Access-Control-Allow-Origin', '*');
	res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

	if (method === 'OPTIONS') {
		res.writeHead(204);
		res.end();
		return;
	}

	let body = '';
	req.on('data', chunk => body += chunk);
	req.on('end', () => {
		try {
			const json = body ? JSON.parse(body) : {};
			routeRequest(method, path, url, json, req, res);
		} catch (e) {
			sendJson(res, 400, { error: 'Invalid JSON' });
		}
	});
}

function routeRequest(method, path, url, body, req, res) {
	// Auth
	if (path === '/v1/auth/login' && method === 'POST') {
		if (body.email === 'demo@deltaplus.io' && body.password === 'demo123') {
			const token = generateToken();
			const refresh = generateToken();
			tokens.set(token, { email: body.email, expires: Date.now() + 3600000 });
			sendJson(res, 200, {
				access_token: token,
				refresh_token: refresh,
				expires_in: 3600,
				user: { id: 'user-1', email: body.email, name: 'Demo User', tier: 'demo' }
			});
		} else {
			sendJson(res, 401, { error: 'Invalid credentials' });
		}
		return;
	}

	// Check auth for protected routes
	const authHeader = req.headers.authorization;
	const token = authHeader?.replace('Bearer ', '');
	if (!token || !tokens.has(token)) {
		if (path !== '/v1/auth/login') {
			sendJson(res, 401, { error: 'Unauthorized' });
			return;
		}
	}

	// Symbols
	if (path === '/v1/symbols' && method === 'GET') {
		sendJson(res, 200, SYMBOLS);
		return;
	}

	const symbolMatch = path.match(/^\/v1\/symbols\/(\w+)$/);
	if (symbolMatch && method === 'GET') {
		const symbol = SYMBOLS.find(s => s.symbol === symbolMatch[1]);
		if (symbol) {
			sendJson(res, 200, symbol);
		} else {
			sendJson(res, 404, { error: 'Symbol not found' });
		}
		return;
	}

	// Bars
	const barsMatch = path.match(/^\/v1\/bars\/(\w+)$/);
	if (barsMatch && method === 'GET') {
		const symbol = barsMatch[1];
		const timeframe = url.searchParams.get('timeframe') || '1D';
		const limit = parseInt(url.searchParams.get('limit') || '100', 10);
		const bars = generateBars(symbol, timeframe, limit);
		sendJson(res, 200, bars);
		return;
	}

	// Watchlists
	if (path === '/v1/watchlists' && method === 'GET') {
		sendJson(res, 200, WATCHLISTS);
		return;
	}

	if (path === '/v1/watchlists' && method === 'POST') {
		const newWatchlist = {
			id: `wl-${Date.now()}`,
			name: body.name || 'New Watchlist',
			symbols: body.symbols || [],
			is_default: false,
			sort_order: WATCHLISTS.length
		};
		WATCHLISTS.push(newWatchlist);
		sendJson(res, 201, newWatchlist);
		return;
	}

	// Demo status
	if (path === '/v1/demo/status' && method === 'GET') {
		sendJson(res, 200, {
			running: true,
			paused: false,
			speed: 1,
			elapsed_minutes: 0,
			symbols: SYMBOLS.map(s => s.symbol)
		});
		return;
	}

	sendJson(res, 404, { error: 'Not found' });
}

function sendJson(res, status, data) {
	res.writeHead(status, { 'Content-Type': 'application/json' });
	res.end(JSON.stringify(data));
}

// HTTP Server
const server = http.createServer(handleRequest);

// WebSocket Server (optional)
if (WebSocketServer) {
	const wss = new WebSocketServer({ server, path: '/ws' });

	wss.on('connection', (ws, req) => {
		console.log('WebSocket client connected');

		// Send periodic quotes
		const interval = setInterval(() => {
			const symbol = SYMBOLS[Math.floor(Math.random() * SYMBOLS.length)];
			const price = symbol.base_price * (1 + (Math.random() - 0.5) * 0.01);
			const quote = {
				type: 'quote',
				symbol: symbol.symbol,
				bid: price * 0.999,
				ask: price * 1.001,
				bid_size: Math.floor(Math.random() * 1000),
				ask_size: Math.floor(Math.random() * 1000),
				last: price,
				last_size: Math.floor(Math.random() * 100),
				volume: Math.floor(Math.random() * 1000000),
				timestamp: new Date().toISOString()
			};
			ws.send(JSON.stringify(quote));
		}, 1000);

		ws.on('message', (data) => {
			console.log('Received:', data.toString());
		});

		ws.on('close', () => {
			clearInterval(interval);
			console.log('WebSocket client disconnected');
		});
	});
}

server.listen(PORT, () => {
	console.log(`\n🚀 Mock Delta Plus Server running at http://localhost:${PORT}`);
	console.log(`   WebSocket at ws://localhost:${PORT}/ws`);
	console.log(`\n   Demo credentials: demo@deltaplus.io / demo123`);
	console.log(`\n   Available endpoints:`);
	console.log(`   - POST /v1/auth/login`);
	console.log(`   - GET  /v1/symbols`);
	console.log(`   - GET  /v1/bars/{symbol}?timeframe=1D&limit=100`);
	console.log(`   - GET  /v1/watchlists`);
	console.log(`   - GET  /v1/demo/status`);
	console.log(`\n   Press Ctrl+C to stop\n`);
});
