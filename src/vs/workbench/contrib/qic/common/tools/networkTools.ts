/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Quantlab. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { sha256Hex } from '../qicCrypto.js';
import type { ToolResultPayload } from '../canonical/types.js';
import type { EgressBoundaryEnforcer } from '../security/egressEnforcer.js';
import type { OptimizedSecretScanner } from '../security/secretScanner.js';
import { QicError } from '../canonical/types.js';

let _dnsLookup: ((hostname: string) => Promise<{ address: string }>) | null = null;
async function getDnsLookup(): Promise<(hostname: string) => Promise<{ address: string }>> {
	if (!_dnsLookup) {
		// @ts-ignore
		const dns = await import('dns');
		const { promisify } = await import('util');
		_dnsLookup = promisify(dns.lookup) as (hostname: string) => Promise<{ address: string }>;
	}
	return _dnsLookup;
}

// XI-SV6: SSRF blocked IP patterns
const BLOCKED_IP_PATTERNS: RegExp[] = [
	/^10\./,
	/^172\.(1[6-9]|2[0-9]|3[01])\./,
	/^192\.168\./,
	/^127\./,
	/^169\.254\./,
	/^0\./,
	/^::1$/,
	/^fe80:/i,
	/^fc00:/i,
	/^fd[0-9a-f]{2}:/i,
	/^100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\./,  // CGN RFC 6598
];

const BLOCKED_HOSTNAMES = new Set(['localhost', 'metadata.google.internal']);

// I-SG1: Web search cache
const searchCache = new Map<string, { result: string; timestamp: number }>();
const CACHE_TTL_MS = 300_000; // 5 minutes
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 10;
let searchRequestTimestamps: number[] = [];

/**
 * Web search provider configuration.
 */
export interface WebSearchProviderConfig {
	provider: 'tavily' | 'brave' | 'google' | 'none';
	apiKey?: string;
	baseUrl?: string;
}

interface WebSearchResult {
	title: string;
	url: string;
	snippet: string;
}

/**
 * Network tools (2 tools): web_fetch, web_search.
 *
 * XI-SV6: SSRF prevention for web_fetch.
 * I-SG1: Full web_search implementation with pluggable providers.
 */
export class NetworkTools {

	private searchConfig: WebSearchProviderConfig = { provider: 'none' };

	constructor(
		private readonly egressEnforcer: EgressBoundaryEnforcer,
		private readonly secretScanner: OptimizedSecretScanner,
	) {}

	/**
	 * Configure the web search provider. Called during activation from settings.
	 */
	setSearchProvider(config: WebSearchProviderConfig): void {
		this.searchConfig = config;
	}

	// 13. web_fetch
	async webFetch(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const url = String(args.url ?? '');
			if (!url) {
				return { content: 'Error: url is required', isError: true };
			}

			// XI-SV6: SSRF prevention
			await this.validateUrlForSSRF(url);

			// Egress check
			const egressResult = await this.egressEnforcer.checkAndSanitize('web-fetch', url, {
				sessionId: 'current',
				purpose: 'web_fetch tool',
			});

			if (!egressResult.allowed) {
				return { content: `Egress blocked: ${egressResult.reason ?? 'Not allowed'}`, isError: true };
			}

			const method = String(args.method ?? 'GET').toUpperCase();
			const headers = (args.headers as Record<string, string>) ?? {};

			const response = await fetch(url, { method, headers, redirect: 'manual' });
			const text = await response.text();

			return {
				content: JSON.stringify({
					status: response.status,
					statusText: response.statusText,
					body: text.slice(0, 50_000),
				}),
				isError: !response.ok,
			};
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	// 14. web_search (I-SG1)
	async webSearch(args: Record<string, unknown>): Promise<ToolResultPayload> {
		try {
			const query = String(args.query ?? '');
			if (!query) {
				return { content: 'Error: query is required', isError: true };
			}

			const maxResults = Number(args.maxResults) || 10;

			// Rate limiting
			const now = Date.now();
			searchRequestTimestamps = searchRequestTimestamps.filter(t => now - t < RATE_LIMIT_WINDOW_MS);
			if (searchRequestTimestamps.length >= RATE_LIMIT_MAX) {
				return { content: 'Rate limited: too many search requests', isError: true };
			}
			searchRequestTimestamps.push(now);

			// Secret redaction before sending
			const scanResult = this.secretScanner.scan(query);
			const safeQuery = scanResult.redactedText;
			if (scanResult.hasSecrets) {
				console.warn('[QIC] Secrets redacted from web search query');
			}

			// Cache check
			const cacheKey = sha256Hex(`search:${safeQuery}:${maxResults}`);

			const cached = searchCache.get(cacheKey);
			if (cached && now - cached.timestamp < CACHE_TTL_MS) {
				return { content: cached.result, isError: false };
			}

			// Egress check
			const egressResult = await this.egressEnforcer.checkAndSanitize('web-search', safeQuery, {
				sessionId: 'current',
				purpose: 'web_search tool',
			});

			if (!egressResult.allowed) {
				return { content: `Egress blocked: ${egressResult.reason ?? 'Not allowed'}`, isError: true };
			}

			// Dispatch to configured provider
			let searchResults: WebSearchResult[];
			switch (this.searchConfig.provider) {
				case 'tavily':
					searchResults = await this.searchViaTavily(safeQuery, maxResults);
					break;
				case 'brave':
					searchResults = await this.searchViaBrave(safeQuery, maxResults);
					break;
				case 'google':
					searchResults = await this.searchViaGoogle(safeQuery, maxResults);
					break;
				default:
					return {
						content: JSON.stringify({
							results: [],
							warning: 'No web search provider configured. Set qic.webSearch.provider in settings and provide an API key.',
						}),
						isError: false,
					};
			}

			const result = JSON.stringify({ results: searchResults });

			// Cache the result
			searchCache.set(cacheKey, { result, timestamp: now });

			return { content: result, isError: false };
		} catch (err) {
			return { content: err instanceof Error ? err.message : String(err), isError: true };
		}
	}

	private async searchViaTavily(query: string, maxResults: number): Promise<WebSearchResult[]> {
		const apiKey = this.searchConfig.apiKey;
		if (!apiKey) { throw new QicError('QIC-N002', 'Tavily API key not configured'); }

		const baseUrl = this.searchConfig.baseUrl ?? 'https://api.tavily.com';
		await this.validateSearchProviderUrl(baseUrl);
		const response = await fetch(`${baseUrl}/search`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				api_key: apiKey,
				query,
				max_results: maxResults,
				search_depth: 'basic',
			}),
		});

		if (!response.ok) {
			throw new QicError('QIC-N002', `Tavily search failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as { results?: Array<{ title: string; url: string; content: string }> };
		return (data.results ?? []).map(r => ({
			title: r.title,
			url: r.url,
			snippet: r.content?.slice(0, 500) ?? '',
		}));
	}

	private async searchViaBrave(query: string, maxResults: number): Promise<WebSearchResult[]> {
		const apiKey = this.searchConfig.apiKey;
		if (!apiKey) { throw new QicError('QIC-N002', 'Brave Search API key not configured'); }

		const params = new URLSearchParams({ q: query, count: String(maxResults) });
		const response = await fetch(`https://api.search.brave.com/res/v1/web/search?${params}`, {
			headers: {
				'Accept': 'application/json',
				'Accept-Encoding': 'gzip',
				'X-Subscription-Token': apiKey,
			},
		});

		if (!response.ok) {
			throw new QicError('QIC-N002', `Brave search failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as { web?: { results?: Array<{ title: string; url: string; description: string }> } };
		return (data.web?.results ?? []).map(r => ({
			title: r.title,
			url: r.url,
			snippet: r.description?.slice(0, 500) ?? '',
		}));
	}

	private async searchViaGoogle(query: string, maxResults: number): Promise<WebSearchResult[]> {
		const apiKey = this.searchConfig.apiKey;
		if (!apiKey) { throw new QicError('QIC-N002', 'Google Custom Search API key not configured'); }

		const params = new URLSearchParams({
			key: apiKey,
			q: query,
			num: String(Math.min(maxResults, 10)),
		});
		const response = await fetch(`https://www.googleapis.com/customsearch/v1?${params}`);

		if (!response.ok) {
			throw new QicError('QIC-N002', `Google search failed: ${response.status} ${response.statusText}`);
		}

		const data = await response.json() as { items?: Array<{ title: string; link: string; snippet: string }> };
		return (data.items ?? []).map(r => ({
			title: r.title,
			url: r.link,
			snippet: r.snippet?.slice(0, 500) ?? '',
		}));
	}

	/**
	 * XI-SV6: SSRF prevention — block private/internal addresses.
	 * Validates both the initial URL and handles redirect safety.
	 */
	private async validateUrlForSSRF(url: string): Promise<void> {
		const parsed = new URL(url);
		const hostname = parsed.hostname;

		// Block known internal hostnames (including trailing-dot variants)
		const normalizedHost = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
		if (BLOCKED_HOSTNAMES.has(normalizedHost)) {
			throw new QicError('QIC-N001', `SSRF blocked: ${hostname} is not allowed`);
		}

		// Block numeric IP variants (decimal integer, hex integer, octal)
		if (/^\d+$/.test(hostname)) {
			// Bare integer IP (e.g., 2130706433 = 127.0.0.1)
			throw new QicError('QIC-N001', `SSRF blocked: integer IP addresses are not allowed`);
		}
		if (/^0x[0-9a-f]+$/i.test(hostname)) {
			// Hex integer IP (e.g., 0x7f000001)
			throw new QicError('QIC-N001', `SSRF blocked: hex IP addresses are not allowed`);
		}
		if (/^0\d/.test(hostname)) {
			// Octal IP (e.g., 0177.0.0.1)
			throw new QicError('QIC-N001', `SSRF blocked: octal IP addresses are not allowed`);
		}

		// Block IPv6-mapped IPv4 addresses (e.g., ::ffff:127.0.0.1)
		if (/^::ffff:/i.test(hostname)) {
			throw new QicError('QIC-N001', `SSRF blocked: IPv6-mapped IPv4 addresses are not allowed`);
		}

		for (const pattern of BLOCKED_IP_PATTERNS) {
			if (pattern.test(hostname)) {
				throw new QicError('QIC-N001', `SSRF blocked: ${hostname} is a private/reserved address`);
			}
		}

		// Only allow http/https schemes
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			throw new QicError('QIC-N001', `SSRF blocked: protocol ${parsed.protocol} is not allowed`);
		}

		// DNS rebinding protection: resolve hostname and check resolved IP
		if (!hostname.match(/^\d+\.\d+\.\d+\.\d+$/) && hostname !== 'localhost') {
			try {
				const lookup = await getDnsLookup();
				const { address } = await lookup(normalizedHost);
				for (const pattern of BLOCKED_IP_PATTERNS) {
					if (pattern.test(address)) {
						throw new QicError('QIC-N002', `SSRF blocked: ${hostname} resolves to private address ${address}`);
					}
				}
				if (address === '127.0.0.1' || address === '::1' || address.startsWith('0.')) {
					throw new QicError('QIC-N002', `SSRF blocked: ${hostname} resolves to loopback address ${address}`);
				}
			} catch (err) {
				if (err instanceof QicError) { throw err; }
				// DNS resolution failed — allow (may be running in sandboxed env without dns module)
			}
		}
	}

	/**
	 * Validate that a search provider base URL is a trusted external endpoint.
	 */
	private async validateSearchProviderUrl(baseUrl: string): Promise<void> {
		await this.validateUrlForSSRF(baseUrl);
	}
}
