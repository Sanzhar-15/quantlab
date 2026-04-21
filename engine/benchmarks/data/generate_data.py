"""
Generate synthetic benchmark datasets.

This script generates deterministic synthetic data for performance benchmarking.
Data is seeded for reproducibility.
"""

import csv
import random
from datetime import date
from datetime import timedelta
from decimal import Decimal
from pathlib import Path


def generate_daily_bars(
    start_date: date,
    num_bars: int,
    initial_price: float = 100.0,
    volatility: float = 0.02,
    seed: int = 42,
) -> list[dict]:
    """Generate synthetic daily OHLCV bars."""
    random.seed(seed)

    bars = []
    current_date = start_date
    price = initial_price

    trading_days = 0
    while trading_days < num_bars:
        # Skip weekends
        if current_date.weekday() < 5:  # Monday = 0, Friday = 4
            # Generate random price movement
            daily_return = random.gauss(0.0005, volatility)
            open_price = price
            close_price = price * (1 + daily_return)

            # Generate high/low
            intraday_vol = abs(random.gauss(0, volatility * 0.5))
            high_price = max(open_price, close_price) * (1 + intraday_vol)
            low_price = min(open_price, close_price) * (1 - intraday_vol)

            # Generate volume
            volume = int(random.gauss(1000000, 200000))
            volume = max(100000, volume)

            bars.append({
                "date": current_date.isoformat(),
                "open": f"{open_price:.2f}",
                "high": f"{high_price:.2f}",
                "low": f"{low_price:.2f}",
                "close": f"{close_price:.2f}",
                "volume": volume,
            })

            price = close_price
            trading_days += 1

        current_date += timedelta(days=1)

    return bars


def generate_minute_bars(
    start_date: date,
    num_days: int,
    initial_price: float = 100.0,
    volatility: float = 0.001,
    seed: int = 42,
) -> list[dict]:
    """Generate synthetic minute OHLCV bars for market hours (9:30-16:00)."""
    random.seed(seed)

    bars = []
    current_date = start_date
    price = initial_price

    trading_days = 0
    while trading_days < num_days:
        # Skip weekends
        if current_date.weekday() < 5:
            # 390 minutes per trading day (9:30 - 16:00)
            for minute in range(390):
                hour = 9 + (minute + 30) // 60
                min_of_hour = (minute + 30) % 60
                timestamp = f"{current_date.isoformat()}T{hour:02d}:{min_of_hour:02d}:00"

                # Generate random price movement
                minute_return = random.gauss(0, volatility)
                open_price = price
                close_price = price * (1 + minute_return)

                # Generate high/low
                intraday_vol = abs(random.gauss(0, volatility * 0.3))
                high_price = max(open_price, close_price) * (1 + intraday_vol)
                low_price = min(open_price, close_price) * (1 - intraday_vol)

                # Generate volume
                volume = int(random.gauss(10000, 3000))
                volume = max(1000, volume)

                bars.append({
                    "timestamp": timestamp,
                    "open": f"{open_price:.2f}",
                    "high": f"{high_price:.2f}",
                    "low": f"{low_price:.2f}",
                    "close": f"{close_price:.2f}",
                    "volume": volume,
                })

                price = close_price

            trading_days += 1

        current_date += timedelta(days=1)

    return bars


def generate_multi_symbol_data(
    symbols: list[str],
    start_date: date,
    num_bars: int,
    base_prices: dict[str, float] | None = None,
    seed: int = 42,
) -> list[dict]:
    """Generate synthetic multi-symbol daily data."""
    if base_prices is None:
        base_prices = {sym: 100.0 + i * 50 for i, sym in enumerate(symbols)}

    all_bars = []
    for i, symbol in enumerate(symbols):
        bars = generate_daily_bars(
            start_date=start_date,
            num_bars=num_bars,
            initial_price=base_prices.get(symbol, 100.0),
            volatility=0.02,
            seed=seed + i,  # Different seed per symbol
        )
        for bar in bars:
            bar["symbol"] = symbol
            all_bars.append(bar)

    # Sort by date, then symbol
    all_bars.sort(key=lambda x: (x["date"], x["symbol"]))
    return all_bars


def write_csv(bars: list[dict], filepath: Path) -> None:
    """Write bars to CSV file."""
    if not bars:
        return

    filepath.parent.mkdir(parents=True, exist_ok=True)

    fieldnames = list(bars[0].keys())
    with filepath.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(bars)


def main() -> None:
    """Generate all benchmark datasets."""
    data_dir = Path(__file__).parent

    print("Generating benchmark datasets...")

    # bench_small: 1Y daily (252 bars)
    print("  bench_small (1Y daily, 252 bars)...")
    bars = generate_daily_bars(
        start_date=date(2025, 1, 2),
        num_bars=252,
        seed=42,
    )
    write_csv(bars, data_dir / "bench_small.csv")

    # bench_medium: 5Y daily (1,260 bars)
    print("  bench_medium (5Y daily, 1260 bars)...")
    bars = generate_daily_bars(
        start_date=date(2021, 1, 4),
        num_bars=1260,
        seed=43,
    )
    write_csv(bars, data_dir / "bench_medium.csv")

    # bench_large: 1Y minute (98,280 bars)
    print("  bench_large (1Y minute, ~98k bars)...")
    bars = generate_minute_bars(
        start_date=date(2025, 1, 2),
        num_days=252,
        seed=44,
    )
    write_csv(bars, data_dir / "bench_large.csv")

    # bench_multi: 5Y 10-symbol (12,600 bars)
    print("  bench_multi (5Y 10-symbol, 12600 bars)...")
    symbols = ["AAPL", "MSFT", "GOOGL", "AMZN", "META", "NVDA", "TSLA", "JPM", "V", "JNJ"]
    bars = generate_multi_symbol_data(
        symbols=symbols,
        start_date=date(2021, 1, 4),
        num_bars=1260,
        seed=45,
    )
    write_csv(bars, data_dir / "bench_multi.csv")

    print("Done!")


if __name__ == "__main__":
    main()
