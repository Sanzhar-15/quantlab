/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Fill-driven round-trip P&L accounting (2026-06-11 megaudit H31).
 *
 * Before this module existed, totalTrades / winRate / avgWin / avgLoss /
 * realizedPnL were initialized to 0 in SessionManager.defaultPerformance()
 * and never written again, so the Performance card lied for the entire
 * lifetime of every session. SessionManager now feeds every processed fill
 * through a per-session RoundTripBook and copies the resulting stats into
 * session.performance.
 *
 * Accounting model (deliberately simple, FIFO):
 *
 * - Per symbol the book keeps a FIFO queue of open lots with SIGNED
 *   quantities (positive = long lot, negative = short lot).
 * - A fill on the same side as the open position appends a new lot.
 * - A fill on the opposite side matches FIFO against the open lots. Each
 *   matched share realizes `(fillPrice - lotPrice) * matchedQty` for long
 *   lots and `(lotPrice - fillPrice) * matchedQty` for short lots. The
 *   realized amount is added to `realizedPnL` IMMEDIATELY -- partial exits
 *   realize P&L as they happen, before the round trip completes.
 * - A ROUND TRIP is one flat-to-flat cycle per symbol: it closes when the
 *   symbol's open quantity returns to exactly zero. On close, totalTrades
 *   increments and the cycle's accumulated P&L enters the win/loss history
 *   that winRate / avgWin / avgLoss derive from.
 * - A fill that FLIPS the position (e.g. sell 150 against a 100-share long)
 *   closes the cycle with the matched 100 shares and opens a new short
 *   cycle with the remaining 50.
 * - Commissions: each fill's commission is subtracted from realizedPnL and
 *   attributed to the cycle that is active when the fill arrives (on a
 *   flip, the whole commission goes to the cycle being closed; the entry
 *   fill of a fresh cycle charges that cycle).
 * - winRate is expressed on a 0-100 scale (the trade webview renders it
 *   with `${value.toFixed(1)}%`). avgWin is the mean P&L of winning round
 *   trips (positive); avgLoss is the SIGNED mean P&L of losing round trips
 *   (negative). A round trip with exactly 0 P&L counts as a trade but as
 *   neither win nor loss (it still dilutes winRate via the denominator).
 */

export interface RoundTripFill {
	symbol: string;
	side: 'buy' | 'sell';
	quantity: number;
	price: number;
	commission: number;
}

export interface RoundTripStats {
	totalTrades: number;
	realizedPnL: number;
	winRate: number;
	avgWin: number;
	avgLoss: number;
}

interface OpenLot {
	/** Signed remaining quantity: positive = long, negative = short. Never zero. */
	quantity: number;
	price: number;
}

interface SymbolBook {
	lots: OpenLot[];
	/** P&L (matched realizations + commissions) accumulated in the current flat-to-flat cycle. */
	cyclePnL: number;
}

export class RoundTripBook {
	private readonly books = new Map<string, SymbolBook>();
	private totalTrades = 0;
	private realizedPnL = 0;
	private winCount = 0;
	private winSum = 0;
	private lossCount = 0;
	private lossSum = 0;

	/**
	 * Apply one fill to the book and return the updated aggregate stats.
	 *
	 * Throws on malformed input -- a fill that cannot be accounted for must
	 * fail loudly, not silently corrupt the performance metrics.
	 */
	applyFill(fill: RoundTripFill): RoundTripStats {
		if (fill.side !== 'buy' && fill.side !== 'sell') {
			throw new Error(`RoundTripBook: invalid fill side '${String(fill.side)}' for ${fill.symbol}`);
		}
		if (!Number.isFinite(fill.quantity) || fill.quantity <= 0) {
			throw new Error(`RoundTripBook: invalid fill quantity ${String(fill.quantity)} for ${fill.symbol}`);
		}
		if (!Number.isFinite(fill.price)) {
			throw new Error(`RoundTripBook: invalid fill price ${String(fill.price)} for ${fill.symbol}`);
		}
		if (!Number.isFinite(fill.commission)) {
			throw new Error(`RoundTripBook: invalid fill commission ${String(fill.commission)} for ${fill.symbol}`);
		}

		let book = this.books.get(fill.symbol);
		if (!book) {
			book = { lots: [], cyclePnL: 0 };
			this.books.set(fill.symbol, book);
		}

		// Commission is attributed to the cycle active at fill arrival.
		this.realizedPnL -= fill.commission;
		book.cyclePnL -= fill.commission;

		let remaining = fill.side === 'buy' ? fill.quantity : -fill.quantity;
		while (remaining !== 0) {
			const front = book.lots[0];
			if (front === undefined || Math.sign(front.quantity) === Math.sign(remaining)) {
				// Same direction as the open position (or flat): opens/extends a lot.
				book.lots.push({ quantity: remaining, price: fill.price });
				remaining = 0;
				break;
			}

			// Opposite direction: FIFO-match against the oldest open lot.
			const lotSign = Math.sign(front.quantity);
			const matched = Math.min(Math.abs(remaining), Math.abs(front.quantity));
			const pnl = matched * (fill.price - front.price) * lotSign;
			this.realizedPnL += pnl;
			book.cyclePnL += pnl;

			front.quantity -= lotSign * matched;
			remaining += lotSign * matched;
			if (front.quantity === 0) {
				book.lots.shift();
			}
			if (book.lots.length === 0) {
				// Position returned to flat: one round trip completed.
				this.closeCycle(book);
			}
		}

		return this.stats();
	}

	/** Signed open quantity for a symbol (0 when flat). */
	openQuantity(symbol: string): number {
		const book = this.books.get(symbol);
		if (!book) {
			return 0;
		}
		return book.lots.reduce((sum, lot) => sum + lot.quantity, 0);
	}

	stats(): RoundTripStats {
		return {
			totalTrades: this.totalTrades,
			realizedPnL: this.realizedPnL,
			winRate: this.totalTrades > 0 ? (this.winCount / this.totalTrades) * 100 : 0,
			avgWin: this.winCount > 0 ? this.winSum / this.winCount : 0,
			avgLoss: this.lossCount > 0 ? this.lossSum / this.lossCount : 0
		};
	}

	private closeCycle(book: SymbolBook): void {
		this.totalTrades += 1;
		if (book.cyclePnL > 0) {
			this.winCount += 1;
			this.winSum += book.cyclePnL;
		} else if (book.cyclePnL < 0) {
			this.lossCount += 1;
			this.lossSum += book.cyclePnL;
		}
		book.cyclePnL = 0;
	}
}
