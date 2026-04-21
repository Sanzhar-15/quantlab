/**
 * Calculate appropriate gap threshold based on chart timeframe.
 * Used to detect when line/area series should break (show visual gaps).
 */
export function getGapThresholdMs(timeframe: string): number | undefined {
	const MINUTE_MS = 60 * 1000;
	const HOUR_MS = 60 * MINUTE_MS;
	const DAY_MS = 24 * HOUR_MS;

	switch (timeframe) {
		case '1m': return 10 * MINUTE_MS;  // 10 min gap = likely closed market
		case '5m': return 30 * MINUTE_MS;  // 30 min gap
		case '15m': return 1 * HOUR_MS;    // 1 hour gap
		case '30m': return 2 * HOUR_MS;    // 2 hour gap
		case '1H': return 6 * HOUR_MS;     // 6 hour gap (overnight)
		case '4H': return 2 * DAY_MS;      // 2 day gap (weekend)
		case '1D': return 5 * DAY_MS;      // 5 day gap (long weekend/holiday)
		case '1W': return 14 * DAY_MS;     // 2 week gap
		default: return undefined;          // No gap detection for unknown timeframes
	}
}
