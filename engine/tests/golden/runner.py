"""
Golden Test Runner Infrastructure.

Golden tests are regression tests with predefined inputs and expected outputs.
They ensure the backtest engine produces deterministic, correct results.

Test vector format (YAML):
```yaml
id: G001
name: "Basic market buy order"
category: basic_execution
description: "Market buy order fills at next bar open"

setup:
  initial_cash: "100000"
  calendar: nyse
  fill_assumption: next_open
  slippage: none
  commission: none

data:
  symbol: AAPL
  bars:
    - {date: "2026-01-02", open: "100.00", high: "105.00", low: "99.00", close: "104.00", volume: 1000000}
    - {date: "2026-01-03", open: "104.00", high: "106.00", low: "102.00", close: "103.00", volume: 1200000}
    # ...

signals:
  - {bar_index: 0, action: buy, symbol: AAPL, quantity: "100", order_type: market}

expected:
  fills:
    - {bar_index: 1, symbol: AAPL, quantity: "100", price: "104.00", side: buy}
  final_equity: "100400.00"
  final_positions:
    AAPL: "100"
  metrics:
    total_return: "0.004"
```
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

import yaml

from quantlab.backtest.bar import Bar
from quantlab.backtest.bar import BarSeries
from quantlab.backtest.commission import CommissionModel
from quantlab.backtest.config import BacktestConfig
from quantlab.backtest.core import BacktestEngine
from quantlab.backtest.core import OrderSide
from quantlab.backtest.core import OrderType
from quantlab.backtest.core import Signal
from quantlab.backtest.core import Strategy
from quantlab.backtest.core import TimeInForce
from quantlab.backtest.fills import FillAssumption
from quantlab.backtest.slippage import SlippageModel


@dataclass
class GoldenTestVector:
    """Represents a single golden test vector."""

    id: str
    name: str
    category: str
    description: str

    setup: dict[str, Any]
    data: dict[str, Any]
    signals: list[dict[str, Any]]
    expected: dict[str, Any]

    # Optional metadata
    tags: list[str] = field(default_factory=list)
    skip: bool = False
    skip_reason: str = ""

    @classmethod
    def from_yaml(cls, path: Path) -> "GoldenTestVector":
        """Load a golden test vector from a YAML file."""
        with path.open() as f:
            data = yaml.safe_load(f)

        return cls(
            id=data["id"],
            name=data["name"],
            category=data["category"],
            description=data.get("description", ""),
            setup=data["setup"],
            data=data["data"],
            signals=data["signals"],
            expected=data["expected"],
            tags=data.get("tags", []),
            skip=data.get("skip", False),
            skip_reason=data.get("skip_reason", ""),
        )

    def to_yaml(self, path: Path) -> None:
        """Save the golden test vector to a YAML file."""
        data = {
            "id": self.id,
            "name": self.name,
            "category": self.category,
            "description": self.description,
            "setup": self.setup,
            "data": self.data,
            "signals": self.signals,
            "expected": self.expected,
        }
        if self.tags:
            data["tags"] = self.tags
        if self.skip:
            data["skip"] = self.skip
            data["skip_reason"] = self.skip_reason

        with path.open("w") as f:
            yaml.dump(data, f, default_flow_style=False, sort_keys=False)


@dataclass
class GoldenTestResult:
    """Result of running a golden test."""

    vector_id: str
    passed: bool
    actual: dict[str, Any]
    expected: dict[str, Any]
    differences: list[str] = field(default_factory=list)
    error: str | None = None


class GoldenVectorStrategy:
    """
    Strategy that generates signals from a golden test vector.

    This interprets the signals defined in the YAML vector file.
    """

    def __init__(self, signals: list[dict[str, Any]]) -> None:
        self._signals = signals
        # Index signals by bar_index for quick lookup
        self._signals_by_bar: dict[int, list[dict[str, Any]]] = {}
        for signal in signals:
            bar_idx = signal.get("bar_index", 0)
            if bar_idx not in self._signals_by_bar:
                self._signals_by_bar[bar_idx] = []
            self._signals_by_bar[bar_idx].append(signal)

    def evaluate(self, data: dict[str, "BarSeries"], bar_index: int) -> list[Signal]:
        """Generate signals for the given bar."""
        result = []

        if bar_index not in self._signals_by_bar:
            return result

        for signal_def in self._signals_by_bar[bar_index]:
            action = signal_def.get("action", "buy")
            side_map = {
                "buy": OrderSide.BUY,
                "sell": OrderSide.SELL,
                "sell_short": OrderSide.SELL_SHORT,
                "buy_to_cover": OrderSide.BUY_TO_COVER,
            }
            side = side_map.get(action, OrderSide.BUY)
            order_type_str = signal_def.get("order_type", "market")
            order_type = {
                "market": OrderType.MARKET,
                "limit": OrderType.LIMIT,
                "stop": OrderType.STOP,
                "stop_limit": OrderType.STOP_LIMIT,
            }.get(order_type_str, OrderType.MARKET)

            tif_str = signal_def.get("time_in_force", "gfd")
            tif = {
                "gfd": TimeInForce.GFD,
                "gtc": TimeInForce.GTC,
                "ioc": TimeInForce.IOC,
            }.get(tif_str, TimeInForce.GFD)

            signal = Signal(
                symbol=signal_def.get("symbol", ""),
                side=side,
                quantity=Decimal(str(signal_def.get("quantity", 0))),
                order_type=order_type,
                limit_price=Decimal(str(signal_def["limit_price"]))
                if signal_def.get("limit_price")
                else None,
                stop_price=Decimal(str(signal_def["stop_price"]))
                if signal_def.get("stop_price")
                else None,
                time_in_force=tif,
            )
            result.append(signal)

        return result


class GoldenTestRunner:
    """
    Runs golden tests against the backtest engine.

    Usage:
        runner = GoldenTestRunner(vectors_dir=Path("tests/golden/vectors"))
        results = runner.run_all()
        runner.report(results)
    """

    def __init__(self, vectors_dir: Path) -> None:
        self.vectors_dir = vectors_dir
        self.vectors: list[GoldenTestVector] = []

    def load_vectors(self, category: str | None = None) -> list[GoldenTestVector]:
        """Load all golden test vectors from the directory."""
        self.vectors = []

        for yaml_file in self.vectors_dir.glob("**/*.yaml"):
            try:
                vector = GoldenTestVector.from_yaml(yaml_file)
                if category is None or vector.category == category:
                    self.vectors.append(vector)
            except Exception as e:
                print(f"Warning: Failed to load {yaml_file}: {e}")

        # Sort by ID for consistent ordering
        self.vectors.sort(key=lambda v: v.id)
        return self.vectors

    def run_vector(self, vector: GoldenTestVector) -> GoldenTestResult:
        """
        Run a single golden test vector.

        Executes the backtest engine with the vector's configuration and signals,
        then compares the actual results against expected values.
        """
        if vector.skip:
            return GoldenTestResult(
                vector_id=vector.id,
                passed=True,  # Skipped tests count as passed
                actual={},
                expected=vector.expected,
                differences=[f"SKIPPED: {vector.skip_reason}"],
            )

        try:
            # Build bar data FIRST to extract date range
            data = self._build_bar_data(vector.data)

            # Extract start and end dates from bar data
            all_timestamps = []
            for symbol, bar_series in data.items():
                for bar in bar_series.bars:
                    all_timestamps.append(bar.timestamp)

            if not all_timestamps:
                raise ValueError("No bar data found in vector")

            start_date = min(all_timestamps)
            end_date = max(all_timestamps)

            # Build backtest configuration from vector setup
            setup = vector.setup

            # Parse fill assumption
            fill_str = setup.get("fill_assumption", "next_open")
            fill_map = {
                "next_open": FillAssumption.NEXT_OPEN,
                "next_close": FillAssumption.NEXT_CLOSE,
                "typical_price": FillAssumption.TYPICAL_PRICE,
            }
            fill_assumption = fill_map.get(fill_str, FillAssumption.NEXT_OPEN)

            # Parse slippage model
            slippage_config = setup.get("slippage", {})
            if isinstance(slippage_config, str):
                slippage_model_str = slippage_config
                slippage_params = {}
            else:
                slippage_model_str = slippage_config.get("model", "none")
                slippage_params = {
                    k: v for k, v in slippage_config.items() if k != "model"
                }
            # Map vector param names to code param names
            if "basis_points" in slippage_params:
                slippage_params["bps"] = slippage_params.pop("basis_points")
            if "impact_factor" in slippage_params:
                slippage_params["impact_coefficient"] = slippage_params.pop("impact_factor")
            slippage_map = {
                "none": SlippageModel.NONE,
                "fixed_bps": SlippageModel.FIXED_BPS,
                "fixed": SlippageModel.FIXED_BPS,  # Alias
                "volatility": SlippageModel.VOLATILITY,
                "volume_impact": SlippageModel.VOLUME_IMPACT,
                "volume": SlippageModel.VOLUME_IMPACT,  # Alias
            }
            slippage_model = slippage_map.get(slippage_model_str, SlippageModel.NONE)

            # Parse commission model
            commission_config = setup.get("commission", {})
            if isinstance(commission_config, str):
                commission_model_str = commission_config
                commission_params = {}
            else:
                commission_model_str = commission_config.get("model", "none")
                commission_params = {
                    k: v for k, v in commission_config.items() if k != "model"
                }
            commission_map = {
                "none": CommissionModel.NONE,
                "per_share": CommissionModel.PER_SHARE,
                "per_trade": CommissionModel.PER_TRADE,
                "flat": CommissionModel.PER_TRADE,  # Alias
                "percentage": CommissionModel.PERCENTAGE,
                "tiered": CommissionModel.TIERED,
            }
            commission_model = commission_map.get(commission_model_str, CommissionModel.NONE)

            # Parse risk limits - check both setup.max_exposure and setup.risk_limits.max_exposure
            risk_limits = setup.get("risk_limits", {})
            if "max_exposure" in setup:
                max_exposure = Decimal(str(setup["max_exposure"]))
            elif "max_exposure" in risk_limits:
                max_exposure = Decimal(str(risk_limits["max_exposure"]))
            else:
                max_exposure = None

            # Parse allow_shorting (default True)
            allow_short = setup.get("allow_shorting", True)

            # Parse short_selling config
            short_selling_config = setup.get("short_selling", {})
            if short_selling_config:
                # If short_selling section exists, parse its values
                allow_short = short_selling_config.get("enabled", allow_short)
                borrow_fee_rate = Decimal(str(short_selling_config.get("borrow_rate", "0")))
                short_collateral_ratio = Decimal(str(short_selling_config.get("collateral_ratio", "1.0")))
            else:
                # Default: no borrow fees for tests unless explicitly specified
                borrow_fee_rate = Decimal("0")
                short_collateral_ratio = Decimal("1.0")

            config = BacktestConfig(
                start_date=start_date,
                end_date=end_date,
                initial_capital=Decimal(str(setup.get("initial_cash", "100000"))),
                calendar=setup.get("calendar", "nyse"),
                fill_assumption=fill_assumption,
                slippage_model=slippage_model,
                slippage_params=slippage_params,
                commission_model=commission_model,
                commission_params=commission_params,
                max_volume_participation=Decimal(
                    str(setup.get("max_volume_participation", "0.1"))
                ),
                max_exposure=max_exposure,
                allow_short=allow_short,
                borrow_fee_rate=borrow_fee_rate,
                short_collateral_ratio=short_collateral_ratio,
            )

            # Create backtest engine
            engine = BacktestEngine(config)

            # Load the pre-built bar data
            engine.load_data(data)

            # Create strategy from vector signals
            strategy = GoldenVectorStrategy(vector.signals)

            # Run the backtest
            result = engine.run(strategy)

            # Build actual results dictionary
            actual: dict[str, Any] = {
                "final_equity": str(result.final_equity),
                "fills": [
                    {
                        "bar_index": fill.bar_index,
                        "symbol": fill.symbol,
                        "quantity": str(fill.quantity),
                        "price": str(fill.price),
                        "side": fill.side.value,
                        "commission": str(fill.commission),
                    }
                    for fill in result.trades
                ],
                "final_positions": {
                    symbol: str(qty)
                    for symbol, qty in engine._state.positions.items()
                },
                "metrics": {
                    "total_return": str(result.total_return),
                    "total_trades": result.total_trades,
                },
            }

            # Add win_rate if there are winning or losing trades
            if result.winning_trades > 0 or result.losing_trades > 0:
                win_rate = result.winning_trades / (result.winning_trades + result.losing_trades)
                actual["metrics"]["win_rate"] = str(win_rate)

            # Calculate short_value and gross_exposure
            long_value = Decimal("0")
            short_value = Decimal("0")
            final_bar_idx = len(data[list(data.keys())[0]]) - 1 if data else 0
            for symbol, qty in engine._state.positions.items():
                if symbol in data and final_bar_idx < len(data[symbol]):
                    price = data[symbol][final_bar_idx].close
                    if qty > Decimal("0"):
                        long_value += qty * price
                    else:
                        short_value += abs(qty) * price

            if short_value > Decimal("0"):
                actual["metrics"]["short_value"] = str(short_value)

            # Gross exposure = (long_value + short_value) / equity
            if result.final_equity > Decimal("0"):
                gross_exposure = (long_value + short_value) / result.final_equity
                if gross_exposure > Decimal("0"):
                    actual["metrics"]["gross_exposure"] = str(gross_exposure.quantize(Decimal("0.0001")))

            # Compare results
            differences = self._compare_results(actual, vector.expected)

            return GoldenTestResult(
                vector_id=vector.id,
                passed=len(differences) == 0,
                actual=actual,
                expected=vector.expected,
                differences=differences,
            )

        except Exception as e:
            return GoldenTestResult(
                vector_id=vector.id,
                passed=False,
                actual={},
                expected=vector.expected,
                error=str(e),
            )

    def _build_bar_data(self, data_def: dict[str, Any]) -> dict[str, BarSeries]:
        """Build BarSeries from vector data definition."""
        result: dict[str, BarSeries] = {}

        # Get timeframe (default to 1d for golden tests)
        timeframe = data_def.get("timeframe", "1d")

        # Handle single symbol format
        if "symbol" in data_def and "bars" in data_def:
            symbol = data_def["symbol"]
            bars = self._build_bars(data_def["bars"], symbol)
            result[symbol] = BarSeries(symbol=symbol, timeframe=timeframe, bars=bars)
        # Handle multi-symbol format
        elif "symbols" in data_def:
            for sym_data in data_def["symbols"]:
                symbol = sym_data["symbol"]
                sym_timeframe = sym_data.get("timeframe", timeframe)
                bars = self._build_bars(sym_data["bars"], symbol)
                result[symbol] = BarSeries(symbol=symbol, timeframe=sym_timeframe, bars=bars)

        return result

    def _build_bars(self, bars_def: list[dict[str, Any]], symbol: str) -> list[Bar]:
        """Build list of Bar objects from definition."""
        bars = []
        for bar_def in bars_def:
            timestamp = datetime.fromisoformat(bar_def["date"])
            bar = Bar(
                timestamp=timestamp,
                open=Decimal(str(bar_def["open"])),
                high=Decimal(str(bar_def["high"])),
                low=Decimal(str(bar_def["low"])),
                close=Decimal(str(bar_def["close"])),
                volume=Decimal(str(bar_def.get("volume", 0))),
                symbol=symbol,
            )
            bars.append(bar)
        return bars

    def run_all(self, category: str | None = None) -> list[GoldenTestResult]:
        """Run all loaded golden test vectors."""
        if not self.vectors:
            self.load_vectors(category)

        results = []
        for vector in self.vectors:
            if category is None or vector.category == category:
                result = self.run_vector(vector)
                results.append(result)

        return results

    def _compare_results(
        self, actual: dict[str, Any], expected: dict[str, Any]
    ) -> list[str]:
        """Compare actual results against expected, return list of differences."""
        differences = []

        # Compare fills
        if "fills" in expected:
            actual_fills = actual.get("fills", [])
            expected_fills = expected["fills"]
            if len(actual_fills) != len(expected_fills):
                differences.append(
                    f"Fill count: expected {len(expected_fills)}, got {len(actual_fills)}"
                )
            else:
                # Detailed fill comparison
                for i, (actual_fill, expected_fill) in enumerate(
                    zip(actual_fills, expected_fills)
                ):
                    fill_diffs = self._compare_fill(actual_fill, expected_fill, i)
                    differences.extend(fill_diffs)

        # Compare final equity
        if "final_equity" in expected:
            actual_equity = actual.get("final_equity", "0")
            expected_equity = expected["final_equity"]
            if not self._decimal_close(actual_equity, expected_equity):
                differences.append(
                    f"Final equity: expected {expected_equity}, got {actual_equity}"
                )

        # Compare final positions
        if "final_positions" in expected:
            actual_positions = actual.get("final_positions", {})
            expected_positions = expected["final_positions"]
            for symbol, expected_qty in expected_positions.items():
                actual_qty = actual_positions.get(symbol, "0")
                if not self._decimal_close(actual_qty, expected_qty):
                    differences.append(
                        f"Position {symbol}: expected {expected_qty}, got {actual_qty}"
                    )

        # Compare metrics
        if "metrics" in expected:
            actual_metrics = actual.get("metrics", {})
            expected_metrics = expected["metrics"]
            for metric, expected_value in expected_metrics.items():
                actual_value = actual_metrics.get(metric)
                if actual_value is None:
                    differences.append(f"Metric {metric}: missing")
                elif not self._decimal_close(actual_value, expected_value, tolerance="0.0001"):
                    differences.append(
                        f"Metric {metric}: expected {expected_value}, got {actual_value}"
                    )

        return differences

    def _decimal_close(
        self, a: str | Decimal, b: str | Decimal, tolerance: str = "0.01"
    ) -> bool:
        """Check if two decimal values are within tolerance."""
        a_dec = Decimal(str(a)) if not isinstance(a, Decimal) else a
        b_dec = Decimal(str(b)) if not isinstance(b, Decimal) else b
        tol = Decimal(tolerance)
        return abs(a_dec - b_dec) <= tol

    def _compare_fill(
        self,
        actual: dict[str, Any],
        expected: dict[str, Any],
        fill_index: int,
    ) -> list[str]:
        """
        Compare a single fill against expected values.

        Args:
            actual: Actual fill from backtest
            expected: Expected fill from vector
            fill_index: Index of fill for error messages

        Returns:
            List of differences found
        """
        differences = []
        prefix = f"Fill {fill_index}"

        # Compare bar_index
        if "bar_index" in expected:
            actual_bar = actual.get("bar_index")
            expected_bar = expected["bar_index"]
            if actual_bar != expected_bar:
                differences.append(
                    f"{prefix} bar_index: expected {expected_bar}, got {actual_bar}"
                )

        # Compare symbol
        if "symbol" in expected:
            actual_symbol = actual.get("symbol")
            expected_symbol = expected["symbol"]
            if actual_symbol != expected_symbol:
                differences.append(
                    f"{prefix} symbol: expected {expected_symbol}, got {actual_symbol}"
                )

        # Compare side
        if "side" in expected:
            actual_side = actual.get("side")
            expected_side = expected["side"]
            if actual_side != expected_side:
                differences.append(
                    f"{prefix} side: expected {expected_side}, got {actual_side}"
                )

        # Compare quantity
        if "quantity" in expected:
            actual_qty = actual.get("quantity", "0")
            expected_qty = expected["quantity"]
            if not self._decimal_close(actual_qty, expected_qty, tolerance="0.0001"):
                differences.append(
                    f"{prefix} quantity: expected {expected_qty}, got {actual_qty}"
                )

        # Compare price
        if "price" in expected:
            actual_price = actual.get("price", "0")
            expected_price = expected["price"]
            if not self._decimal_close(actual_price, expected_price, tolerance="0.01"):
                differences.append(
                    f"{prefix} price: expected {expected_price}, got {actual_price}"
                )

        # Compare commission if specified
        if "commission" in expected:
            actual_commission = actual.get("commission", "0")
            expected_commission = expected["commission"]
            if not self._decimal_close(
                actual_commission, expected_commission, tolerance="0.01"
            ):
                differences.append(
                    f"{prefix} commission: expected {expected_commission}, got {actual_commission}"
                )

        return differences

    def report(self, results: list[GoldenTestResult]) -> str:
        """Generate a summary report of test results."""
        passed = sum(1 for r in results if r.passed)
        failed = len(results) - passed

        lines = [
            "=" * 60,
            "GOLDEN TEST RESULTS",
            "=" * 60,
            f"Total: {len(results)} | Passed: {passed} | Failed: {failed}",
            "-" * 60,
        ]

        for result in results:
            status = "PASS" if result.passed else "FAIL"
            lines.append(f"[{status}] {result.vector_id}")
            if not result.passed:
                if result.error:
                    lines.append(f"       Error: {result.error}")
                for diff in result.differences:
                    lines.append(f"       - {diff}")

        lines.append("=" * 60)
        return "\n".join(lines)


def load_golden_vector(vector_id: str, vectors_dir: Path) -> GoldenTestVector | None:
    """Load a specific golden test vector by ID."""
    for yaml_file in vectors_dir.glob("**/*.yaml"):
        try:
            vector = GoldenTestVector.from_yaml(yaml_file)
            if vector.id == vector_id:
                return vector
        except Exception:
            continue
    return None
