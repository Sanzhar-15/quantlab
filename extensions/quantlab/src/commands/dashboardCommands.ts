/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Dashboard commands -- registers commands for opening data dashboard webview panels.
// Data truth: every renderer below is written against the LIVE server shapes
// (verified 2026-06-11). Sections backed by unprovisioned/unavailable
// endpoints render explicit, honest notes -- never silent empty sections.

import * as vscode from 'vscode';
import { CalendarPage, ServerApiClient } from '../core/server/ServerApiClient';
import { DashboardWebviewPanel, escapeHtml } from '../panels/dashboard/DashboardWebviewPanel';

// --- Shared helpers -----------------------------------------------------------

/** Outcome of one independently fetched dashboard section. */
type SectionResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Awaits one section's fetch and captures failure instead of rejecting, so
 * sibling sections still render (render-boundary handling). The underlying
 * error is always console.error-logged -- failures must stay visible.
 */
async function settleSection<T>(label: string, promise: Promise<T>): Promise<SectionResult<T>> {
	try {
		return { ok: true, value: await promise };
	} catch (err) {
		console.error(`[quantlab.dashboard] ${label} failed:`, err);
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

/** Explicit, styled per-section note for a section whose endpoint failed. */
function unavailableNote(section: string, serverMessage: string): string {
	return `<div class="dash-empty">${escapeHtml(section)}: data temporarily unavailable (server: ${escapeHtml(serverMessage)})</div>`;
}

/** Formats an ISO datetime as a human-readable UTC date, e.g. "Mar 20, 2026". */
function formatUtcDate(iso: string): string {
	const d = new Date(iso);
	if (isNaN(d.getTime())) { return iso; }
	return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** Prettifies snake_case identifiers, e.g. "macro_release" -> "Macro Release", "govt_bond_10y" -> "Govt Bond 10Y". */
function prettifySnakeCase(value: string): string {
	return value.split('_').map(part => {
		if (/^\d+[a-z]$/.test(part)) { return part.toUpperCase(); }
		return part.charAt(0).toUpperCase() + part.slice(1);
	}).join(' ');
}

/** Formats a large USD amount compactly, e.g. 1401897037367 -> "$1.40T". */
function formatLargeUsd(value: number): string {
	const abs = Math.abs(value);
	if (abs >= 1e12) { return '$' + (value / 1e12).toFixed(2) + 'T'; }
	if (abs >= 1e9) { return '$' + (value / 1e9).toFixed(2) + 'B'; }
	if (abs >= 1e6) { return '$' + (value / 1e6).toFixed(1) + 'M'; }
	return '$' + value.toLocaleString();
}

/**
 * Renders a server-sourced numeric field into HTML. The API client checks
 * envelope shapes, not element field types -- so a non-number here is
 * rendered ESCAPED (visible bad data, never raw HTML), and null/undefined
 * render the placeholder dash.
 */
function fmtNum(value: unknown, format?: (n: number) => string): string {
	if (value === undefined || value === null) { return '&mdash;'; }
	if (typeof value === 'number' && Number.isFinite(value)) {
		return format ? format(value) : value.toLocaleString();
	}
	return escapeHtml(String(value));
}

const CALENDAR_ROW_CAP = 50;

/**
 * Unified calendar renderer -- all live calendar endpoints share one event
 * schema: {id, event_type, event_name, datetime_utc, importance, is_tentative}.
 * Columns: Date | Event | Type | Importance (+ tentative marker).
 */
function renderCalendarBody(page: CalendarPage, emptyMessage: string): string {
	if (!page.events.length) { return `<div class="dash-empty">${escapeHtml(emptyMessage)}</div>`; }
	const rows = page.events.slice(0, CALENDAR_ROW_CAP);
	const table = `<table class="dashboard-table">
		<thead><tr><th>Date</th><th>Event</th><th>Type</th><th>Importance</th></tr></thead>
		<tbody>${rows.map(e => `<tr>
			<td>${escapeHtml(formatUtcDate(e.datetime_utc))}</td>
			<td>${escapeHtml(e.event_name)}${e.is_tentative ? ' <span class="dash-tentative">(tentative)</span>' : ''}</td>
			<td>${escapeHtml(prettifySnakeCase(e.event_type))}</td>
			<td>${escapeHtml(e.importance)}</td>
		</tr>`).join('')}</tbody>
	</table>`;
	const countNote = `<p class="section-label">Showing ${rows.length} of ${fmtNum(page.total)} events</p>`;
	return table + countNote;
}

function registerCalendarDashboard(
	context: vscode.ExtensionContext,
	command: string,
	id: string,
	title: string,
	fetchPage: () => Promise<CalendarPage>,
	emptyMessage: string,
): void {
	context.subscriptions.push(
		vscode.commands.registerCommand(command, () => {
			void DashboardWebviewPanel.show(context, {
				id,
				title,
				fetchData: fetchPage,
				renderBody: (page) => renderCalendarBody(page, emptyMessage),
			});
		})
	);
}

export function registerDashboardCommands(context: vscode.ExtensionContext): void {
	const client = ServerApiClient.getInstance();

	// --- Market Overview ------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openMarketOverview', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.marketOverview',
				title: 'Market Overview',
				// Sections settle independently: /v1/global-indices/ and /v1/etfs/
				// are live-503 today; the healthy symbols section must still render.
				fetchData: async () => {
					const [symbols, indices, etfs] = await Promise.all([
						settleSection('Market Overview symbols', client.getSymbols()),
						settleSection('Market Overview global indices', client.getGlobalIndices()),
						settleSection('Market Overview ETFs', client.getEtfs()),
					]);
					return { symbols, indices, etfs };
				},
				renderBody: (data) => {
					const cards = `<div class="summary-cards">
						${data.symbols.ok ? `<div class="summary-card"><div class="label">Equities</div><div class="value">${data.symbols.value.length}</div><div class="sub">symbols tracked</div></div>` : ''}
						${data.indices.ok ? `<div class="summary-card"><div class="label">Global Indices</div><div class="value">${data.indices.value.length}</div></div>` : ''}
						${data.etfs.ok ? `<div class="summary-card"><div class="label">ETFs</div><div class="value">${data.etfs.value.length}</div></div>` : ''}
					</div>`;
					const symbolsNote = data.symbols.ok ? '' : unavailableNote('Equities', data.symbols.error);
					const indicesSection = data.indices.ok
						? (data.indices.value.length ? `
							<p class="section-label">Global Indices</p>
							<table class="dashboard-table">
								<thead><tr><th>Symbol</th><th>Name</th><th>Region</th><th>Value</th><th>Change %</th></tr></thead>
								<tbody>${data.indices.value.map(idx => `<tr>
									<td>${escapeHtml(idx.symbol ?? idx.id ?? '')}</td>
									<td>${escapeHtml(idx.name ?? '')}</td>
									<td>${escapeHtml(idx.region ?? '')}</td>
									<td>${fmtNum(idx.value)}</td>
									<td>${fmtNum(idx.change_pct, n => n.toFixed(2) + '%')}</td>
								</tr>`).join('')}</tbody>
							</table>` : '')
						: unavailableNote('Global Indices', data.indices.error);
					const etfsNote = data.etfs.ok ? '' : unavailableNote('ETFs', data.etfs.error);
					return cards + symbolsNote + indicesSection + etfsNote;
				},
			});
		})
	);

	// --- Crypto Overview ------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openCryptoOverview', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.cryptoOverview',
				title: 'Crypto Overview',
				fetchData: () => client.getCryptoSymbols(),
				renderBody: (data) => {
					const cards = `<div class="summary-cards">
						<div class="summary-card"><div class="label">Coins</div><div class="value">${data.length}</div><div class="sub">tracked on server</div></div>
					</div>`;
					const table = data.length ? `
						<table class="dashboard-table">
							<thead><tr><th>Rank</th><th>Symbol</th><th>Name</th><th>Price</th><th>Market Cap</th><th>Exchanges</th></tr></thead>
							<tbody>${data.slice(0, 100).map(s => `<tr>
								<td>${fmtNum(s.market_cap_rank)}</td>
								<td>${escapeHtml(s.symbol)}</td>
								<td>${escapeHtml(s.name)}</td>
								<td>${fmtNum(s.current_price, n => '$' + n.toLocaleString())}</td>
								<td>${fmtNum(s.market_cap, formatLargeUsd)}</td>
								<td>${fmtNum(s.exchange_count)}</td>
							</tr>`).join('')}</tbody>
						</table>
						${data.length > 100 ? `<p class="section-label">Showing first 100 of ${data.length} coins</p>` : ''}` : '<div class="dash-empty">No crypto symbols available</div>';
					return cards + table;
				},
			});
		})
	);

	// --- Yield Curve ----------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openYieldCurve', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.yieldCurve',
				title: 'Yield Curve',
				fetchData: () => client.getYieldCurve(),
				// Live shape is a bare array of {metric, value} records -- there
				// is no tenor breakdown or date grouping server-side.
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No yield curve data available</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Metric</th><th>Value (%)</th></tr></thead>
						<tbody>${data.map(d => `<tr>
							<td>${escapeHtml(prettifySnakeCase(d.metric))}</td>
							<td>${fmtNum(d.value, n => n.toFixed(2))}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// --- Calendars (unified live event schema) --------------------------------
	registerCalendarDashboard(context,
		'quantlab.openEconomicCalendar', 'quantlab.dashboard.economicCalendar', 'Economic Calendar',
		() => client.getCalendarEconomic(), 'No upcoming economic events');
	registerCalendarDashboard(context,
		'quantlab.openEarningsCalendar', 'quantlab.dashboard.earningsCalendar', 'Earnings Calendar',
		() => client.getCalendarEarnings(), 'No upcoming earnings');
	registerCalendarDashboard(context,
		'quantlab.openDividendsCalendar', 'quantlab.dashboard.dividendsCalendar', 'Dividends Calendar',
		() => client.getCalendarDividends(), 'No upcoming dividends');
	registerCalendarDashboard(context,
		'quantlab.openIPOCalendar', 'quantlab.dashboard.ipoCalendar', 'IPO Calendar',
		() => client.getCalendarIPOs(), 'No upcoming IPOs');
	registerCalendarDashboard(context,
		'quantlab.openSplitsCalendar', 'quantlab.dashboard.splitsCalendar', 'Stock Splits',
		() => client.getCalendarSplits(), 'No upcoming splits');

	// --- Calendar: Central Bank -----------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openCentralBankCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.centralBankCalendar',
				title: 'Central Bank Calendar',
				// Honest pane: /v1/calendar/central-bank is 404 on the live
				// server (verified 2026-06-11). No fetch -- the pane says so.
				fetchData: async () => null,
				renderBody: () => '<div class="dash-empty">The central-bank calendar is not yet provisioned server-side (endpoint /v1/calendar/central-bank returns 404). This dashboard will activate once the server provides the data.</div>',
			});
		})
	);

	// --- Sentiment Dashboard --------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openSentimentDashboard', async () => {
			const symbol = await vscode.window.showInputBox({
				prompt: 'Enter symbol for sentiment analysis',
				placeHolder: 'e.g. AAPL',
			});
			if (!symbol) { return; }
			void DashboardWebviewPanel.show(context, {
				id: `quantlab.dashboard.sentiment.${symbol.toUpperCase()}`,
				title: `Sentiment: ${symbol.toUpperCase()}`,
				fetchData: () => client.getSentiment(symbol.toUpperCase()),
				// Live fields: overall_sentiment + *_percent (0-100) + news_count.
				// There is no composite 'score' server-side -- none is fabricated.
				renderBody: (data) => {
					return `<div class="summary-cards">
						<div class="summary-card"><div class="label">Overall</div><div class="value">${escapeHtml(data.overall_sentiment)}</div><div class="sub">as of ${escapeHtml(formatUtcDate(data.updated_at))}</div></div>
						<div class="summary-card"><div class="label">Bullish</div><div class="value">${fmtNum(data.bullish_percent, n => n.toFixed(1))}%</div></div>
						<div class="summary-card"><div class="label">Bearish</div><div class="value">${fmtNum(data.bearish_percent, n => n.toFixed(1))}%</div></div>
						<div class="summary-card"><div class="label">Neutral</div><div class="value">${fmtNum(data.neutral_percent, n => n.toFixed(1))}%</div></div>
						<div class="summary-card"><div class="label">News Count</div><div class="value">${fmtNum(data.news_count)}</div></div>
					</div>`;
				},
			});
		})
	);

	// --- News Flow ------------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openNewsFlow', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.newsFlow',
				title: 'News Flow',
				fetchData: () => client.getNews(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No news available</div>'; }
					return `<ul class="news-list">${data.map(n => `<li>
						<div class="news-title">${escapeHtml(n.title)}</div>
						<div class="news-meta">${escapeHtml(n.source)} · ${escapeHtml(formatUtcDate(n.published_at))}${n.categories?.length ? ' · ' + n.categories.map(c => escapeHtml(c)).join(', ') : ''}</div>
						${n.summary ? `<div class="news-summary">${escapeHtml(n.summary)}</div>` : ''}
					</li>`).join('')}</ul>`;
				},
			});
		})
	);

	// --- Fundamentals ---------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openFundamentals', async () => {
			const symbol = await vscode.window.showInputBox({
				prompt: 'Enter symbol for fundamentals',
				placeHolder: 'e.g. AAPL',
			});
			if (!symbol) { return; }
			const sym = symbol.toUpperCase();
			void DashboardWebviewPanel.show(context, {
				id: `quantlab.dashboard.fundamentals.${sym}`,
				title: `Fundamentals: ${sym}`,
				fetchData: async () => {
					const [profile, financials, ratios] = await Promise.all([
						client.getFundamentalsProfile(sym),
						client.getFundamentalsFinancials(sym),
						client.getFundamentalsRatios(sym),
					]);
					return { profile, financials, ratios };
				},
				renderBody: (data) => {
					const p = data.profile;
					const profileCard = `<div class="summary-cards">
						<div class="summary-card"><div class="label">Company</div><div class="value">${escapeHtml(String(p.name ?? sym))}</div><div class="sub">${escapeHtml(String(p.sector ?? ''))} · ${escapeHtml(String(p.industry ?? ''))}</div></div>
						<div class="summary-card"><div class="label">Market Cap</div><div class="value">${fmtNum(p.market_cap, formatLargeUsd)}</div></div>
						<div class="summary-card"><div class="label">Employees</div><div class="value">${fmtNum(p.employees)}</div></div>
						<div class="summary-card"><div class="label">CEO</div><div class="value" style="font-size:14px">${p.ceo !== undefined && p.ceo !== null ? escapeHtml(String(p.ceo)) : '&mdash;'}</div></div>
					</div>`;

					// Live financials nest line items in statements[], newest first.
					const f = data.financials;
					const s = f.statements.length ? f.statements[0] : undefined;
					const financialsTable = s ? `<p class="section-label">Financials (${escapeHtml(f.type)}, ${escapeHtml(f.period)}, period ending ${escapeHtml(s.period_end)})</p>
					<table class="dashboard-table">
						<thead><tr><th>Metric</th><th>Value</th></tr></thead>
						<tbody>
							<tr><td>Revenue</td><td>${fmtNum(s.revenue, formatLargeUsd)}</td></tr>
							<tr><td>Gross Profit</td><td>${fmtNum(s.gross_profit, formatLargeUsd)}</td></tr>
							<tr><td>Operating Income</td><td>${fmtNum(s.operating_income, formatLargeUsd)}</td></tr>
							<tr><td>Net Income</td><td>${fmtNum(s.net_income, formatLargeUsd)}</td></tr>
							<tr><td>EBITDA</td><td>${fmtNum(s.ebitda, formatLargeUsd)}</td></tr>
							<tr><td>EPS</td><td>${fmtNum(s.eps, n => '$' + n.toFixed(2))}</td></tr>
						</tbody>
					</table>` : '<div class="dash-empty">No financial statements available</div>';

					// Live ratio names are *_ratio suffixed; returns/margins are fractions.
					const r = data.ratios;
					const pct = (v: number | undefined): string => fmtNum(v, n => (n * 100).toFixed(2) + '%');
					const num = (v: number | undefined): string => fmtNum(v, n => n.toFixed(2));
					const ratiosTable = `<p class="section-label">Valuation Ratios</p>
					<table class="dashboard-table">
						<thead><tr><th>Ratio</th><th>Value</th></tr></thead>
						<tbody>
							<tr><td>P/E</td><td>${num(r.pe_ratio)}</td></tr>
							<tr><td>PEG</td><td>${num(r.peg_ratio)}</td></tr>
							<tr><td>P/B</td><td>${num(r.pb_ratio)}</td></tr>
							<tr><td>P/S</td><td>${num(r.ps_ratio)}</td></tr>
							<tr><td>EV/EBITDA</td><td>${num(r.ev_to_ebitda)}</td></tr>
							<tr><td>Price/FCF</td><td>${num(r.price_to_fcf)}</td></tr>
							<tr><td>Dividend Yield</td><td>${pct(r.dividend_yield)}</td></tr>
							<tr><td>ROE</td><td>${pct(r.roe)}</td></tr>
							<tr><td>ROIC</td><td>${pct(r.roic)}</td></tr>
							<tr><td>ROA</td><td>${pct(r.roa)}</td></tr>
							<tr><td>Gross Margin</td><td>${pct(r.gross_margin)}</td></tr>
							<tr><td>Operating Margin</td><td>${pct(r.operating_margin)}</td></tr>
							<tr><td>Net Margin</td><td>${pct(r.net_margin)}</td></tr>
							<tr><td>Debt/Equity</td><td>${num(r.debt_to_equity)}</td></tr>
							<tr><td>Current Ratio</td><td>${num(r.current_ratio)}</td></tr>
							<tr><td>Beta</td><td>${num(r.beta)}</td></tr>
						</tbody>
					</table>`;

					return profileCard + financialsTable + ratiosTable;
				},
			});
		})
	);

	// --- Institutional --------------------------------------------------------
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openInstitutional', async () => {
			const symbol = await vscode.window.showInputBox({
				prompt: 'Enter symbol for institutional data',
				placeHolder: 'e.g. AAPL',
			});
			if (!symbol) { return; }
			const sym = symbol.toUpperCase();
			void DashboardWebviewPanel.show(context, {
				id: `quantlab.dashboard.institutional.${sym}`,
				title: `Institutional: ${sym}`,
				// Both endpoints are live-503 today; sections settle independently
				// so each renders an honest note instead of one red error pane.
				fetchData: async () => {
					const [holdings, insiders] = await Promise.all([
						settleSection('Institutional holdings', client.getInstitutionalHoldings(sym)),
						settleSection('Institutional insiders', client.getInstitutionalInsiders(sym)),
					]);
					return { holdings, insiders };
				},
				renderBody: (data) => {
					const holdingsSection = data.holdings.ok
						? (data.holdings.value.length ? `
							<p class="section-label">Institutional Holdings</p>
							<table class="dashboard-table">
								<thead><tr><th>Holder</th><th>Shares</th><th>Value</th><th>Change</th><th>Date</th></tr></thead>
								<tbody>${data.holdings.value.map(h => `<tr>
									<td>${escapeHtml(String(h.holder ?? ''))}</td>
									<td>${fmtNum(h.shares)}</td>
									<td>${fmtNum(h.value, formatLargeUsd)}</td>
									<td>${fmtNum(h.change)}</td>
									<td>${escapeHtml(String(h.date_reported ?? ''))}</td>
								</tr>`).join('')}</tbody>
							</table>` : '<div class="dash-empty">No holdings data</div>')
						: unavailableNote('Institutional Holdings', data.holdings.error);

					const insidersSection = data.insiders.ok
						? (data.insiders.value.length ? `
							<p class="section-label">Insider Transactions</p>
							<table class="dashboard-table">
								<thead><tr><th>Name</th><th>Title</th><th>Type</th><th>Shares</th><th>Price</th><th>Value</th><th>Date</th></tr></thead>
								<tbody>${data.insiders.value.map(i => `<tr>
									<td>${escapeHtml(String(i.name ?? ''))}</td>
									<td>${escapeHtml(String(i.title ?? ''))}</td>
									<td>${escapeHtml(String(i.transaction_type ?? ''))}</td>
									<td>${fmtNum(i.shares)}</td>
									<td>${fmtNum(i.price, n => '$' + n.toFixed(2))}</td>
									<td>${fmtNum(i.value, formatLargeUsd)}</td>
									<td>${escapeHtml(String(i.date ?? ''))}</td>
								</tr>`).join('')}</tbody>
							</table>` : '<div class="dash-empty">No insider data</div>')
						: unavailableNote('Insider Transactions', data.insiders.error);

					return holdingsSection + insidersSection;
				},
			});
		})
	);
}
