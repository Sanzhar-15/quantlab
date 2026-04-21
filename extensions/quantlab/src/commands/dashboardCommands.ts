/*---------------------------------------------------------------------------------------------
 *  Dashboard commands — registers commands for opening data dashboard webview panels.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ServerApiClient } from '../core/server/ServerApiClient';
import { DashboardWebviewPanel, escapeHtml } from '../panels/dashboard/DashboardWebviewPanel';

export function registerDashboardCommands(context: vscode.ExtensionContext): void {
	const client = ServerApiClient.getInstance();

	// ─── Market Overview ──────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openMarketOverview', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.marketOverview',
				title: 'Market Overview',
				fetchData: async () => {
					const [symbols, indices, etfs] = await Promise.all([
						client.getSymbols(),
						client.getGlobalIndices(),
						client.getEtfs(),
					]);
					return { symbols, indices, etfs };
				},
				renderBody: (data) => {
					const cards = `<div class="summary-cards">
						<div class="summary-card"><div class="label">Equities</div><div class="value">${data.symbols.length}</div><div class="sub">symbols tracked</div></div>
						<div class="summary-card"><div class="label">Global Indices</div><div class="value">${data.indices.length}</div></div>
						<div class="summary-card"><div class="label">ETFs</div><div class="value">${data.etfs.length}</div></div>
					</div>`;
					const indicesTable = data.indices.length ? `
						<p class="section-label">Global Indices</p>
						<table class="dashboard-table">
							<thead><tr><th>Symbol</th><th>Name</th><th>Region</th><th>Value</th><th>Change %</th></tr></thead>
							<tbody>${data.indices.map(idx => `<tr>
								<td>${escapeHtml(idx.symbol ?? idx.id ?? '')}</td>
								<td>${escapeHtml(idx.name ?? '')}</td>
								<td>${escapeHtml(idx.region ?? '')}</td>
								<td>${idx.value != null ? idx.value.toLocaleString() : '—'}</td>
								<td>${idx.change_pct != null ? idx.change_pct.toFixed(2) + '%' : '—'}</td>
							</tr>`).join('')}</tbody>
						</table>` : '';
					return cards + indicesTable;
				},
			});
		})
	);

	// ─── Crypto Overview ──────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openCryptoOverview', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.cryptoOverview',
				title: 'Crypto Overview',
				fetchData: () => client.getCryptoSymbols(),
				renderBody: (data) => {
					const cards = `<div class="summary-cards">
						<div class="summary-card"><div class="label">Crypto Pairs</div><div class="value">${data.length}</div><div class="sub">across exchanges</div></div>
					</div>`;
					const table = data.length ? `
						<table class="dashboard-table">
							<thead><tr><th>Symbol</th><th>Name</th><th>Exchange</th></tr></thead>
							<tbody>${data.slice(0, 100).map(s => `<tr>
								<td>${escapeHtml(s.symbol.replace('_', '/'))}</td>
								<td>${escapeHtml(s.name ?? '')}</td>
								<td>${escapeHtml(s.exchange ?? '')}</td>
							</tr>`).join('')}</tbody>
						</table>
						${data.length > 100 ? `<p class="dash-empty">Showing first 100 of ${data.length} pairs</p>` : ''}` : '';
					return cards + table;
				},
			});
		})
	);

	// ─── Yield Curve ──────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openYieldCurve', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.yieldCurve',
				title: 'Yield Curve',
				fetchData: () => client.getYieldCurve(),
				renderBody: (data) => {
					if (data.data && data.data.length) {
						return `
							${data.date ? `<p class="section-label">As of ${escapeHtml(data.date)}</p>` : ''}
							<table class="dashboard-table">
								<thead><tr><th>Tenor</th><th>Yield (%)</th></tr></thead>
								<tbody>${data.data.map(d => `<tr>
									<td>${escapeHtml(d.tenor)}</td>
									<td>${d.yield.toFixed(3)}</td>
								</tr>`).join('')}</tbody>
							</table>`;
					}
					if (data.tenors) {
						const entries = Object.entries(data.tenors);
						return `
							${data.date ? `<p class="section-label">As of ${escapeHtml(data.date)}</p>` : ''}
							<table class="dashboard-table">
								<thead><tr><th>Tenor</th><th>Yield (%)</th></tr></thead>
								<tbody>${entries.map(([t, y]) => `<tr>
									<td>${escapeHtml(t)}</td>
									<td>${y.toFixed(3)}</td>
								</tr>`).join('')}</tbody>
							</table>`;
					}
					return '<div class="dash-empty">No yield curve data available</div>';
				},
			});
		})
	);

	// ─── Calendar: Economic ───────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openEconomicCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.economicCalendar',
				title: 'Economic Calendar',
				fetchData: () => client.getCalendarEconomic(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No upcoming economic events</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Date</th><th>Time</th><th>Country</th><th>Event</th><th>Actual</th><th>Forecast</th><th>Previous</th></tr></thead>
						<tbody>${data.map(e => `<tr>
							<td>${escapeHtml(String(e.date ?? ''))}</td>
							<td>${escapeHtml(String(e.time ?? ''))}</td>
							<td>${escapeHtml(String(e.country ?? ''))}</td>
							<td>${escapeHtml(String(e.event ?? ''))}</td>
							<td>${escapeHtml(String(e.actual ?? '—'))}</td>
							<td>${escapeHtml(String(e.forecast ?? '—'))}</td>
							<td>${escapeHtml(String(e.previous ?? '—'))}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// ─── Calendar: Earnings ───────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openEarningsCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.earningsCalendar',
				title: 'Earnings Calendar',
				fetchData: () => client.getCalendarEarnings(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No upcoming earnings</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Date</th><th>Symbol</th><th>Company</th><th>EPS Est.</th><th>EPS Act.</th><th>Rev. Est.</th><th>Rev. Act.</th></tr></thead>
						<tbody>${data.map(e => `<tr>
							<td>${escapeHtml(String(e.date ?? ''))}</td>
							<td>${escapeHtml(String(e.symbol ?? ''))}</td>
							<td>${escapeHtml(String(e.company ?? ''))}</td>
							<td>${e.eps_estimate != null ? e.eps_estimate.toFixed(2) : '—'}</td>
							<td>${e.eps_actual != null ? e.eps_actual.toFixed(2) : '—'}</td>
							<td>${e.revenue_estimate != null ? '$' + (e.revenue_estimate / 1e6).toFixed(1) + 'M' : '—'}</td>
							<td>${e.revenue_actual != null ? '$' + (e.revenue_actual / 1e6).toFixed(1) + 'M' : '—'}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// ─── Calendar: Dividends ──────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openDividendsCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.dividendsCalendar',
				title: 'Dividends Calendar',
				fetchData: () => client.getCalendarDividends(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No upcoming dividends</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Symbol</th><th>Company</th><th>Ex-Date</th><th>Pay Date</th><th>Dividend</th></tr></thead>
						<tbody>${data.map(e => `<tr>
							<td>${escapeHtml(String(e.symbol ?? ''))}</td>
							<td>${escapeHtml(String(e.company ?? ''))}</td>
							<td>${escapeHtml(String(e.ex_date ?? e.date ?? ''))}</td>
							<td>${escapeHtml(String(e.pay_date ?? ''))}</td>
							<td>${e.dividend != null ? '$' + e.dividend.toFixed(2) : '—'}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// ─── Calendar: IPOs ───────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openIPOCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.ipoCalendar',
				title: 'IPO Calendar',
				fetchData: () => client.getCalendarIPOs(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No upcoming IPOs</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Date</th><th>Company</th><th>Symbol</th><th>Exchange</th><th>Price Range</th></tr></thead>
						<tbody>${data.map(e => `<tr>
							<td>${escapeHtml(String(e.date ?? ''))}</td>
							<td>${escapeHtml(String(e.company ?? ''))}</td>
							<td>${escapeHtml(String(e.symbol ?? ''))}</td>
							<td>${escapeHtml(String(e.exchange ?? ''))}</td>
							<td>${escapeHtml(String(e.price_range ?? '—'))}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// ─── Calendar: Splits ─────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openSplitsCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.splitsCalendar',
				title: 'Stock Splits',
				fetchData: () => client.getCalendarSplits(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No upcoming splits</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Date</th><th>Symbol</th><th>Company</th><th>Ratio</th></tr></thead>
						<tbody>${data.map(e => `<tr>
							<td>${escapeHtml(String(e.date ?? ''))}</td>
							<td>${escapeHtml(String(e.symbol ?? ''))}</td>
							<td>${escapeHtml(String(e.company ?? ''))}</td>
							<td>${escapeHtml(String(e.ratio ?? '—'))}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// ─── Calendar: Central Bank ───────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openCentralBankCalendar', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.centralBankCalendar',
				title: 'Central Bank Calendar',
				fetchData: () => client.getCalendarCentralBank(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No upcoming central bank events</div>'; }
					return `<table class="dashboard-table">
						<thead><tr><th>Date</th><th>Central Bank</th><th>Event</th><th>Rate</th><th>Previous</th><th>Decision</th></tr></thead>
						<tbody>${data.map(e => `<tr>
							<td>${escapeHtml(String(e.date ?? ''))}</td>
							<td>${escapeHtml(String(e.central_bank ?? ''))}</td>
							<td>${escapeHtml(String(e.event ?? ''))}</td>
							<td>${e.rate != null ? e.rate.toFixed(2) + '%' : '—'}</td>
							<td>${e.previous_rate != null ? e.previous_rate.toFixed(2) + '%' : '—'}</td>
							<td>${escapeHtml(String(e.decision ?? '—'))}</td>
						</tr>`).join('')}</tbody>
					</table>`;
				},
			});
		})
	);

	// ─── Sentiment Dashboard ──────────────────────────────────────────────────
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
				renderBody: (data) => {
					return `<div class="summary-cards">
						<div class="summary-card"><div class="label">Score</div><div class="value">${data.score != null ? data.score.toFixed(2) : '—'}</div><div class="sub">${escapeHtml(String(data.label ?? ''))}</div></div>
						<div class="summary-card"><div class="label">Bullish</div><div class="value">${data.bullish != null ? (data.bullish * 100).toFixed(1) + '%' : '—'}</div></div>
						<div class="summary-card"><div class="label">Bearish</div><div class="value">${data.bearish != null ? (data.bearish * 100).toFixed(1) + '%' : '—'}</div></div>
						<div class="summary-card"><div class="label">Neutral</div><div class="value">${data.neutral != null ? (data.neutral * 100).toFixed(1) + '%' : '—'}</div></div>
					</div>`;
				},
			});
		})
	);

	// ─── News Flow ────────────────────────────────────────────────────────────
	context.subscriptions.push(
		vscode.commands.registerCommand('quantlab.openNewsFlow', () => {
			void DashboardWebviewPanel.show(context, {
				id: 'quantlab.dashboard.newsFlow',
				title: 'News Flow',
				fetchData: () => client.getNews(),
				renderBody: (data) => {
					if (!data.length) { return '<div class="dash-empty">No news available</div>'; }
					return `<ul class="news-list">${data.map(n => `<li>
						<div class="news-title">${escapeHtml(String(n.title ?? ''))}</div>
						<div class="news-meta">${escapeHtml(String(n.source ?? ''))} · ${escapeHtml(String(n.published_at ?? ''))}${n.symbols?.length ? ' · ' + n.symbols.map(s => escapeHtml(s)).join(', ') : ''}</div>
						${n.summary ? `<div class="news-summary">${escapeHtml(String(n.summary))}</div>` : ''}
					</li>`).join('')}</ul>`;
				},
			});
		})
	);

	// ─── Fundamentals ─────────────────────────────────────────────────────────
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
						<div class="summary-card"><div class="label">Market Cap</div><div class="value">${p.market_cap != null ? '$' + (p.market_cap / 1e9).toFixed(2) + 'B' : '—'}</div></div>
						<div class="summary-card"><div class="label">Employees</div><div class="value">${p.employees != null ? p.employees.toLocaleString() : '—'}</div></div>
						<div class="summary-card"><div class="label">CEO</div><div class="value" style="font-size:14px">${escapeHtml(String(p.ceo ?? '—'))}</div></div>
					</div>`;

					const f = data.financials;
					const financialsTable = `<p class="section-label">Financials</p>
					<table class="dashboard-table">
						<thead><tr><th>Metric</th><th>Value</th></tr></thead>
						<tbody>
							<tr><td>Revenue</td><td>${f.revenue != null ? '$' + (f.revenue / 1e9).toFixed(2) + 'B' : '—'}</td></tr>
							<tr><td>Net Income</td><td>${f.net_income != null ? '$' + (f.net_income / 1e9).toFixed(2) + 'B' : '—'}</td></tr>
							<tr><td>EPS</td><td>${f.eps != null ? '$' + f.eps.toFixed(2) : '—'}</td></tr>
							<tr><td>P/E Ratio</td><td>${f.pe_ratio != null ? f.pe_ratio.toFixed(2) : '—'}</td></tr>
						</tbody>
					</table>`;

					const r = data.ratios;
					const ratiosTable = `<p class="section-label">Valuation Ratios</p>
					<table class="dashboard-table">
						<thead><tr><th>Ratio</th><th>Value</th></tr></thead>
						<tbody>
							<tr><td>P/E</td><td>${r.pe != null ? r.pe.toFixed(2) : '—'}</td></tr>
							<tr><td>P/B</td><td>${r.pb != null ? r.pb.toFixed(2) : '—'}</td></tr>
							<tr><td>P/S</td><td>${r.ps != null ? r.ps.toFixed(2) : '—'}</td></tr>
							<tr><td>Dividend Yield</td><td>${r.dividend_yield != null ? (r.dividend_yield * 100).toFixed(2) + '%' : '—'}</td></tr>
							<tr><td>ROE</td><td>${r.roe != null ? (r.roe * 100).toFixed(2) + '%' : '—'}</td></tr>
							<tr><td>ROA</td><td>${r.roa != null ? (r.roa * 100).toFixed(2) + '%' : '—'}</td></tr>
							<tr><td>Debt/Equity</td><td>${r.debt_to_equity != null ? r.debt_to_equity.toFixed(2) : '—'}</td></tr>
							<tr><td>Current Ratio</td><td>${r.current_ratio != null ? r.current_ratio.toFixed(2) : '—'}</td></tr>
						</tbody>
					</table>`;

					return profileCard + financialsTable + ratiosTable;
				},
			});
		})
	);

	// ─── Institutional ────────────────────────────────────────────────────────
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
				fetchData: async () => {
					const [holdings, insiders] = await Promise.all([
						client.getInstitutionalHoldings(sym),
						client.getInstitutionalInsiders(sym),
					]);
					return { holdings, insiders };
				},
				renderBody: (data) => {
					const holdingsTable = data.holdings.length ? `
						<p class="section-label">Institutional Holdings</p>
						<table class="dashboard-table">
							<thead><tr><th>Holder</th><th>Shares</th><th>Value</th><th>Change</th><th>Date</th></tr></thead>
							<tbody>${data.holdings.map(h => `<tr>
								<td>${escapeHtml(String(h.holder ?? ''))}</td>
								<td>${h.shares != null ? h.shares.toLocaleString() : '—'}</td>
								<td>${h.value != null ? '$' + (h.value / 1e6).toFixed(1) + 'M' : '—'}</td>
								<td>${h.change != null ? h.change.toLocaleString() : '—'}</td>
								<td>${escapeHtml(String(h.date_reported ?? ''))}</td>
							</tr>`).join('')}</tbody>
						</table>` : '<div class="dash-empty">No holdings data</div>';

					const insidersTable = data.insiders.length ? `
						<p class="section-label">Insider Transactions</p>
						<table class="dashboard-table">
							<thead><tr><th>Name</th><th>Title</th><th>Type</th><th>Shares</th><th>Price</th><th>Value</th><th>Date</th></tr></thead>
							<tbody>${data.insiders.map(i => `<tr>
								<td>${escapeHtml(String(i.name ?? ''))}</td>
								<td>${escapeHtml(String(i.title ?? ''))}</td>
								<td>${escapeHtml(String(i.transaction_type ?? ''))}</td>
								<td>${i.shares != null ? i.shares.toLocaleString() : '—'}</td>
								<td>${i.price != null ? '$' + i.price.toFixed(2) : '—'}</td>
								<td>${i.value != null ? '$' + (i.value / 1e6).toFixed(1) + 'M' : '—'}</td>
								<td>${escapeHtml(String(i.date ?? ''))}</td>
							</tr>`).join('')}</tbody>
						</table>` : '<div class="dash-empty">No insider data</div>';

					return holdingsTable + insidersTable;
				},
			});
		})
	);
}
