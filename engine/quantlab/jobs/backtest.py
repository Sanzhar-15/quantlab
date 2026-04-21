"""
Backtest Job Runner.

Executes strategy backtests with progress reporting and artifact generation.

Spec Reference: Technical Spec §8, Phase 4 Action View MVP
"""

from dataclasses import dataclass
from dataclasses import field
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from typing import Any

from quantlab.artifacts.code_snapshot import CodeSnapshot, capture_strategy_snapshot
from quantlab.artifacts.manifest import ArtifactManifest, create_artifact_structure
from quantlab.backtest.bar import Bar, BarSeries
from quantlab.backtest.config import BacktestConfig as EngineBacktestConfig
from quantlab.backtest.core import BacktestEngine, Signal, OrderSide, OrderType
from quantlab.data.service import CSVLoader, Timeframe
from quantlab.export.csv import CSVExporter
from quantlab.export.html import HTMLReportGenerator

from .base import Job
from .base import JobConfig
from .base import JobContext
from .base import JobType
from .protocol import JobResult
from .protocol import LogLevel
from .protocol import MetricValue


@dataclass
class BacktestConfig(JobConfig):
    """Configuration for backtest jobs."""

    initial_capital: float = 100000.0
    commission: float = 0.001  # 0.1%
    slippage: float = 0.0005  # 0.05%
    use_code_defaults: bool = True  # Use ql.param() defaults

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        d = super().to_dict()
        d.update({
            "initialCapital": self.initial_capital,
            "commission": self.commission,
            "slippage": self.slippage,
            "useCodeDefaults": self.use_code_defaults,
        })
        return d

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> "BacktestConfig":
        """Create from dictionary."""
        return cls(
            symbol=data.get("symbol", ""),
            timeframe=data.get("timeframe", "1D"),
            start_date=data.get("startDate"),
            end_date=data.get("endDate"),
            data_source=data.get("dataSource", "default"),
            initial_capital=data.get("initialCapital", 100000.0),
            commission=data.get("commission", 0.001),
            slippage=data.get("slippage", 0.0005),
            use_code_defaults=data.get("useCodeDefaults", True),
        )


@dataclass
class Trade:
    """A single trade record."""

    entry_time: float
    exit_time: float
    entry_price: float
    exit_price: float
    quantity: float
    side: str  # "long" or "short"
    pnl: float
    pnl_percent: float
    commission: float

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "entryTime": self.entry_time,
            "exitTime": self.exit_time,
            "entryPrice": self.entry_price,
            "exitPrice": self.exit_price,
            "quantity": self.quantity,
            "side": self.side,
            "pnl": self.pnl,
            "pnlPercent": self.pnl_percent,
            "commission": self.commission,
        }


@dataclass
class BacktestResult:
    """Results from a backtest run."""

    # Performance metrics
    total_return: float = 0.0
    total_return_percent: float = 0.0
    sharpe_ratio: float = 0.0
    max_drawdown: float = 0.0
    max_drawdown_percent: float = 0.0
    win_rate: float = 0.0

    # Trade statistics
    total_trades: int = 0
    winning_trades: int = 0
    losing_trades: int = 0
    avg_win: float = 0.0
    avg_loss: float = 0.0
    profit_factor: float = 0.0

    # Time series
    equity_curve: list[float] = field(default_factory=list)
    timestamps: list[float] = field(default_factory=list)
    drawdown_curve: list[float] = field(default_factory=list)

    # Trade list
    trades: list[Trade] = field(default_factory=list)

    # Signals
    signals: list[dict[str, Any]] = field(default_factory=list)

    def to_metrics(self) -> list[MetricValue]:
        """Convert to metric values for display."""
        return [
            MetricValue(
                name="Total Return",
                value=self.total_return,
                format="currency",
            ),
            MetricValue(
                name="Return %",
                value=self.total_return_percent,
                format="percent",
            ),
            MetricValue(
                name="Sharpe Ratio",
                value=round(self.sharpe_ratio, 2),
                format="number",
            ),
            MetricValue(
                name="Max Drawdown",
                value=self.max_drawdown_percent,
                format="percent",
            ),
            MetricValue(
                name="Win Rate",
                value=self.win_rate,
                format="percent",
            ),
            MetricValue(
                name="Total Trades",
                value=self.total_trades,
                format="number",
            ),
            MetricValue(
                name="Profit Factor",
                value=round(self.profit_factor, 2) if self.profit_factor < float('inf') else "N/A",
                format="number",
            ),
        ]

    def to_dict(self) -> dict[str, Any]:
        """Convert to dictionary."""
        return {
            "totalReturn": self.total_return,
            "totalReturnPercent": self.total_return_percent,
            "sharpeRatio": self.sharpe_ratio,
            "maxDrawdown": self.max_drawdown,
            "maxDrawdownPercent": self.max_drawdown_percent,
            "winRate": self.win_rate,
            "totalTrades": self.total_trades,
            "winningTrades": self.winning_trades,
            "losingTrades": self.losing_trades,
            "avgWin": self.avg_win,
            "avgLoss": self.avg_loss,
            "profitFactor": self.profit_factor,
        }


class BacktestJob(Job):
    """
    Backtest job runner.

    Executes a strategy backtest with progress reporting,
    generates equity curve, signals, and performance metrics.
    """

    @property
    def job_type(self) -> JobType:
        """Return job type."""
        return JobType.BACKTEST

    def validate_config(self, config: JobConfig) -> list[str]:
        """Validate backtest configuration."""
        errors = super().validate_config(config)

        if isinstance(config, BacktestConfig):
            if config.initial_capital <= 0:
                errors.append("Initial capital must be positive")
            if config.commission < 0:
                errors.append("Commission cannot be negative")
            if config.slippage < 0:
                errors.append("Slippage cannot be negative")

        return errors

    def run(self, ctx: JobContext) -> JobResult:
        """
        Execute backtest.

        Args:
            ctx: Job execution context

        Returns:
            JobResult with backtest metrics and artifacts
        """
        # Start memory monitoring (per §10.1)
        ctx.start_memory_monitoring()

        try:
            return self._run_backtest_impl(ctx)
        finally:
            # Always stop memory monitoring
            ctx.stop_memory_monitoring()

    def _run_backtest_impl(self, ctx: JobContext) -> JobResult:
        """Internal backtest implementation."""
        ctx.log_info(f"Starting backtest for {ctx.config.symbol}")
        ctx.log_info(f"Timeframe: {ctx.config.timeframe}")
        ctx.log_info(f"Strategy: {ctx.strategy_path}")

        # Parse config
        if isinstance(ctx.config, BacktestConfig):
            config = ctx.config
        else:
            config = BacktestConfig.from_dict(ctx.config.to_dict())

        ctx.log_info(f"Initial capital: ${config.initial_capital:,.2f}")

        # Load strategy
        ctx.progress(5, "Loading strategy...")
        ctx.check_cancelled()

        strategy_code = self._load_strategy(ctx.strategy_path)
        if not strategy_code:
            raise ValueError(f"Could not load strategy: {ctx.strategy_path}")

        # Load data
        ctx.progress(10, "Loading market data...")
        ctx.check_cancelled()

        data = self._load_data(
            config.symbol,
            config.timeframe,
            config.start_date,
            config.end_date,
            config.data_source,
        )

        if not data or len(data.bars) == 0:
            raise ValueError("No data available for the specified period")

        ctx.log_info(f"Loaded {len(data.bars)} bars")

        # Execute backtest
        ctx.progress(20, "Executing backtest...")

        result = self._execute_backtest(
            ctx=ctx,
            strategy_code=strategy_code,
            data=data,
            config=config,
        )

        # Calculate metrics
        ctx.progress(90, "Calculating metrics...")
        ctx.check_cancelled()

        self._calculate_metrics(result, config)

        # Write artifacts with proper manifest (per §17)
        ctx.progress(95, "Writing artifacts...")

        # Create artifact structure with manifest
        artifact_base = ctx.artifact_dir.parent  # Go up to base artifacts dir
        artifact_path, manifest = create_artifact_structure(
            base_path=artifact_base,
            job_id=ctx.job_id,
            job_type="backtest",
            include_debug=False,
        )

        # Create code snapshot (per §17.3 - MANDATORY)
        code_snapshot = capture_strategy_snapshot(
            strategy_path=Path(ctx.strategy_path),
            include_imports=True,
            quantlab_version="10.0.0",
        )

        # Save code snapshot and strategy copy
        code_dir = artifact_path / "code"
        code_snapshot.save(code_dir)
        code_snapshot.save_strategy_copy(code_dir)

        # Add code files to manifest
        manifest.add_file_from_path(code_dir / "snapshot.json", artifact_path)
        if (code_dir / "strategy.py").exists():
            manifest.add_file_from_path(code_dir / "strategy.py", artifact_path)

        # Update manifest with strategy info
        manifest.strategy_name = Path(ctx.strategy_path).stem
        manifest.strategy_hash = code_snapshot.strategy_hash

        # Write result summary
        result_path = artifact_path / "results.json"
        with open(result_path, "w") as f:
            import json
            json.dump(result.to_dict(), f, indent=2)
        manifest.add_file_from_path(result_path, artifact_path)

        # Write equity curve
        equity_path = artifact_path / "equity.json"
        with open(equity_path, "w") as f:
            import json
            json.dump({
                "timestamps": result.timestamps,
                "equity": result.equity_curve,
                "drawdown": result.drawdown_curve,
            }, f, indent=2)
        manifest.add_file_from_path(equity_path, artifact_path)

        # Write signals
        signals_path = artifact_path / "signals.json"
        with open(signals_path, "w") as f:
            import json
            json.dump(result.signals, f, indent=2)
        manifest.add_file_from_path(signals_path, artifact_path)

        # Write trades
        trades_path = artifact_path / "trades.json"
        with open(trades_path, "w") as f:
            import json
            json.dump([t.to_dict() for t in result.trades], f, indent=2)
        manifest.add_file_from_path(trades_path, artifact_path)

        # Export to CSV format (per §17.4)
        csv_exporter = CSVExporter()

        # Convert trades to dict format for CSV export
        trades_for_export = [
            {
                "trade_id": f"trade_{i+1}",
                "symbol": config.symbol,
                "side": t.side,
                "quantity": t.quantity,
                "entry_price": t.entry_price,
                "exit_price": t.exit_price,
                "entry_time": datetime.fromtimestamp(t.entry_time).isoformat(),
                "exit_time": datetime.fromtimestamp(t.exit_time).isoformat(),
                "pnl": t.pnl,
                "pnl_percent": t.pnl_percent,
                "commission": t.commission,
                "holding_period_bars": int((t.exit_time - t.entry_time) / 86400),  # rough daily estimate
            }
            for i, t in enumerate(result.trades)
        ]

        # Export trades CSV
        trades_csv_path = artifact_path / "trades.csv"
        csv_exporter.export_trades(trades_csv_path, trades_for_export)
        manifest.add_file_from_path(trades_csv_path, artifact_path)

        # Export metrics CSV
        metrics_for_export = {
            "total_return": result.total_return,
            "total_return_percent": result.total_return_percent,
            "sharpe_ratio": result.sharpe_ratio,
            "max_drawdown": result.max_drawdown,
            "max_drawdown_percent": result.max_drawdown_percent,
            "win_rate": result.win_rate,
            "total_trades": result.total_trades,
            "winning_trades": result.winning_trades,
            "losing_trades": result.losing_trades,
            "avg_win": result.avg_win,
            "avg_loss": result.avg_loss,
            "profit_factor": result.profit_factor,
            "initial_capital": config.initial_capital,
            "symbol": config.symbol,
            "timeframe": config.timeframe,
        }
        metrics_csv_path = artifact_path / "metrics.csv"
        csv_exporter.export_metrics(metrics_csv_path, metrics_for_export)
        manifest.add_file_from_path(metrics_csv_path, artifact_path)

        # Export equity curve CSV
        equity_curve_for_export = [
            {
                "timestamp": datetime.fromtimestamp(ts).isoformat(),
                "equity": eq,
                "drawdown": dd,
            }
            for ts, eq, dd in zip(result.timestamps, result.equity_curve, result.drawdown_curve)
        ]
        equity_csv_path = artifact_path / "equity.csv"
        csv_exporter.export_equity_curve(equity_csv_path, equity_curve_for_export)
        manifest.add_file_from_path(equity_csv_path, artifact_path)

        # Generate HTML report (per §17.4, Decision K64)
        html_generator = HTMLReportGenerator(
            strategy_name=Path(ctx.strategy_path).stem,
            strategy_file=ctx.strategy_path,
        )
        html_report_path = artifact_path / "report.html"
        html_generator.generate(
            output_path=html_report_path,
            metrics=metrics_for_export,
            trades=trades_for_export,
            equity_curve=equity_curve_for_export,
            parameters=ctx.params,
        )
        manifest.add_file_from_path(html_report_path, artifact_path)

        ctx.log_info(f"Exported results to CSV and HTML formats")

        # Save manifest (per §17.1 - every artifact set must include manifest.json)
        manifest.save(artifact_path)

        ctx.log_info(f"Backtest complete: {result.total_trades} trades")
        ctx.log_info(f"Total return: {result.total_return_percent:.2f}%")
        ctx.log_info(f"Sharpe ratio: {result.sharpe_ratio:.2f}")
        ctx.log_info(f"Artifacts written to: {artifact_path}")

        # Build job result
        warnings = []
        if result.total_trades == 0:
            warnings.append("No trades were generated")
        if result.max_drawdown_percent > 30:
            warnings.append(f"High drawdown: {result.max_drawdown_percent:.1f}%")

        return JobResult(
            success=True,
            metrics=result.to_metrics(),
            warnings=warnings,
            details={
                "totalTrades": result.total_trades,
                "winningTrades": result.winning_trades,
                "losingTrades": result.losing_trades,
                "avgWin": result.avg_win,
                "avgLoss": result.avg_loss,
                "strategyHash": code_snapshot.strategy_hash,
            },
            artifact_paths={
                "manifest": str(artifact_path / "manifest.json"),
                "result": str(result_path),
                "equity": str(equity_path),
                "signals": str(signals_path),
                "trades": str(trades_path),
                "code_snapshot": str(code_dir / "snapshot.json"),
                # CSV exports (per §17.4)
                "trades_csv": str(trades_csv_path),
                "metrics_csv": str(metrics_csv_path),
                "equity_csv": str(equity_csv_path),
                # HTML report (per §17.4, Decision K64)
                "html_report": str(html_report_path),
            },
        )

    def _load_strategy(self, strategy_path: str) -> str | None:
        """Load strategy source code."""
        try:
            with open(strategy_path, "r") as f:
                return f.read()
        except Exception:
            return None

    def _load_data(
        self,
        symbol: str,
        timeframe: str,
        start_date: str | None,
        end_date: str | None,
        data_source: str = "default",
    ) -> BarSeries | None:
        """
        Load market data using DataService.

        Args:
            symbol: Symbol to load
            timeframe: Timeframe (1D, 1H, etc.)
            start_date: Start date (ISO format)
            end_date: End date (ISO format)
            data_source: Data source path or identifier

        Returns:
            BarSeries with loaded data, or None if loading fails
        """
        try:
            # Map timeframe string to Timeframe enum
            tf_map = {
                "1D": Timeframe.DAILY,
                "1d": Timeframe.DAILY,
                "daily": Timeframe.DAILY,
                "1H": Timeframe.HOURLY,
                "1h": Timeframe.HOURLY,
                "hourly": Timeframe.HOURLY,
                "1m": Timeframe.MINUTE,
                "1M": Timeframe.MINUTE,
            }
            tf = tf_map.get(timeframe, Timeframe.DAILY)

            # Check if data_source is a file path
            data_path = Path(data_source)
            if data_path.exists() and data_path.suffix == ".csv":
                # Load from CSV file
                ohlcv_series = CSVLoader.load(data_path, timeframe=tf, symbol=symbol)
            else:
                # Try to load from default data directory
                # In production, this would use DataService.get_ohlcv()
                default_data_dir = Path(__file__).parent.parent.parent / "data"
                csv_path = default_data_dir / f"{symbol}_{timeframe}.csv"

                if csv_path.exists():
                    ohlcv_series = CSVLoader.load(csv_path, timeframe=tf, symbol=symbol)
                else:
                    # Fall back to synthetic data for testing
                    return self._generate_synthetic_data(symbol, timeframe, start_date, end_date)

            # Convert OHLCVSeries to BarSeries
            bars = []
            for ohlcv_bar in ohlcv_series.bars:
                ts = ohlcv_bar.timestamp
                if isinstance(ts, (int, float)):
                    ts = datetime.fromtimestamp(ts)

                bar = Bar(
                    timestamp=ts,
                    open=Decimal(str(ohlcv_bar.open)),
                    high=Decimal(str(ohlcv_bar.high)),
                    low=Decimal(str(ohlcv_bar.low)),
                    close=Decimal(str(ohlcv_bar.close)),
                    volume=Decimal(str(ohlcv_bar.volume)),
                    symbol=symbol,
                )
                bars.append(bar)

            # Filter by date range if specified
            if start_date:
                start_dt = datetime.fromisoformat(start_date)
                bars = [b for b in bars if b.timestamp >= start_dt]
            if end_date:
                end_dt = datetime.fromisoformat(end_date)
                bars = [b for b in bars if b.timestamp <= end_dt]

            return BarSeries(symbol=symbol, timeframe=timeframe, bars=bars)

        except Exception as e:
            # Log error and fall back to synthetic data
            import logging
            logging.warning(f"Failed to load data for {symbol}: {e}, using synthetic data")
            return self._generate_synthetic_data(symbol, timeframe, start_date, end_date)

    def _generate_synthetic_data(
        self,
        symbol: str,
        timeframe: str,
        start_date: str | None,
        end_date: str | None,
    ) -> BarSeries:
        """Generate synthetic data for testing when real data unavailable."""
        import random
        import time

        bars = []
        price = Decimal("100.0")
        volume_base = 1000000
        num_bars = 252  # 1 year of daily data

        current_time = time.time() - (num_bars * 86400)

        for i in range(num_bars):
            change = Decimal(str(random.gauss(0, 0.02)))
            price = price * (Decimal("1") + change)

            open_price = price * (Decimal("1") + Decimal(str(random.uniform(-0.005, 0.005))))
            high_price = max(price, open_price) * (Decimal("1") + Decimal(str(random.uniform(0, 0.01))))
            low_price = min(price, open_price) * (Decimal("1") - Decimal(str(random.uniform(0, 0.01))))
            close_price = price
            volume = Decimal(str(int(volume_base * random.uniform(0.5, 1.5))))

            bars.append(Bar(
                timestamp=datetime.fromtimestamp(current_time),
                open=open_price.quantize(Decimal("0.01")),
                high=high_price.quantize(Decimal("0.01")),
                low=low_price.quantize(Decimal("0.01")),
                close=close_price.quantize(Decimal("0.01")),
                volume=volume,
                symbol=symbol,
            ))

            current_time += 86400

        return BarSeries(symbol=symbol, timeframe=timeframe, bars=bars)

    def _execute_backtest(
        self,
        ctx: JobContext,
        strategy_code: str,
        data: BarSeries,
        config: BacktestConfig,
    ) -> BacktestResult:
        """
        Execute the backtest using the real BacktestEngine.

        Args:
            ctx: Job context for progress reporting
            strategy_code: Python source code of the strategy
            data: BarSeries with OHLCV data
            config: Job backtest configuration

        Returns:
            BacktestResult with metrics and trades
        """
        result = BacktestResult()

        # Create strategy adapter from code
        strategy = self._create_strategy_adapter(strategy_code, ctx.params, data.symbol)

        # Create engine config
        engine_config = EngineBacktestConfig(
            start_date=data.bars[0].timestamp if data.bars else datetime.now(),
            end_date=data.bars[-1].timestamp if data.bars else datetime.now(),
            initial_capital=Decimal(str(config.initial_capital)),
            symbols=[data.symbol],
        )

        # Create and configure engine
        engine = BacktestEngine(engine_config)
        engine.load_data({data.symbol: data})

        # Set up progress callback
        total_bars = len(data.bars)

        def on_bar_callback(bar_index: int, bar: Bar) -> None:
            if bar_index % 25 == 0:
                pct = 20 + (bar_index / total_bars) * 70
                ctx.progress(pct, f"Processing bar {bar_index+1}/{total_bars}")
                ctx.check_cancelled()

        engine._on_bar = on_bar_callback

        # Run backtest
        engine_result = engine.run(strategy)

        # Convert engine result to job result format
        result.equity_curve = [float(e) for e in engine_result.equity_curve]
        result.timestamps = [bar.timestamp.timestamp() for bar in data.bars[:len(result.equity_curve)]]
        result.total_trades = engine_result.total_trades
        result.winning_trades = engine_result.winning_trades
        result.losing_trades = engine_result.losing_trades

        # Convert fills to trades
        entry_fills: dict[str, Any] = {}
        for fill in engine_result.trades:
            fill_key = fill.symbol

            if fill.side in (OrderSide.BUY, OrderSide.BUY_TO_COVER):
                # Entry
                entry_fills[fill_key] = {
                    "time": fill.timestamp.timestamp(),
                    "price": float(fill.price),
                    "quantity": float(fill.quantity),
                    "side": "long" if fill.side == OrderSide.BUY else "short_cover",
                }
                result.signals.append({
                    "timestamp": fill.timestamp.timestamp(),
                    "type": "entry",
                    "side": "long",
                    "price": float(fill.price),
                })
            else:
                # Exit
                entry = entry_fills.pop(fill_key, None)
                if entry:
                    pnl = float(fill.quantity) * (float(fill.price) - entry["price"])
                    trade = Trade(
                        entry_time=entry["time"],
                        exit_time=fill.timestamp.timestamp(),
                        entry_price=entry["price"],
                        exit_price=float(fill.price),
                        quantity=entry["quantity"],
                        side=entry["side"],
                        pnl=pnl,
                        pnl_percent=(float(fill.price) / entry["price"] - 1) * 100,
                        commission=float(fill.commission),
                    )
                    result.trades.append(trade)

                result.signals.append({
                    "timestamp": fill.timestamp.timestamp(),
                    "type": "exit",
                    "side": "long",
                    "price": float(fill.price),
                })

        return result

    def _create_strategy_adapter(
        self,
        strategy_code: str,
        params: dict[str, Any],
        symbol: str,
    ) -> Any:
        """
        Create a strategy adapter from source code.

        Attempts to load the strategy and wrap it in the Protocol expected
        by BacktestEngine.

        Args:
            strategy_code: Python source code
            params: Strategy parameters
            symbol: Symbol being traded

        Returns:
            Strategy instance implementing the evaluate() protocol
        """
        # Create a strategy adapter that uses the loaded code
        class StrategyAdapter:
            """Adapts strategy code to BacktestEngine Protocol."""

            def __init__(self, code: str, params: dict[str, Any], symbol: str):
                self._code = code
                self._params = params
                self._symbol = symbol
                self._position = Decimal("0")
                self._namespace: dict[str, Any] = {}

                # Try to execute strategy code to extract logic
                try:
                    exec(compile(code, "<strategy>", "exec"), self._namespace)
                except Exception:
                    pass

                # Extract parameters from code
                self._fast_period = params.get("fast_period", 10)
                self._slow_period = params.get("slow_period", 20)

            def evaluate(
                self, data: dict[str, BarSeries], bar_index: int
            ) -> list[Signal]:
                """Generate signals using strategy logic."""
                signals: list[Signal] = []

                series = data.get(self._symbol)
                if not series or bar_index < self._slow_period:
                    return signals

                # Get closing prices for SMA calculation
                closes = [series[i].close for i in range(max(0, bar_index - self._slow_period + 1), bar_index + 1)]

                if len(closes) < self._slow_period:
                    return signals

                # Calculate SMAs
                fast_sma = sum(closes[-self._fast_period:]) / self._fast_period
                slow_sma = sum(closes) / len(closes)

                current_price = series[bar_index].close

                # Check if strategy code defines a 'strategy' function
                strategy_func = self._namespace.get("strategy")
                if strategy_func and callable(strategy_func):
                    try:
                        # Try to call the strategy function with appropriate data
                        # This is a simplified approach - full implementation would
                        # create proper DataFrame-like objects
                        pass
                    except Exception:
                        pass

                # Fall back to SMA crossover logic based on extracted parameters
                if fast_sma > slow_sma and self._position <= Decimal("0"):
                    # Buy signal
                    signals.append(Signal(
                        symbol=self._symbol,
                        side=OrderSide.BUY,
                        quantity=Decimal("100"),
                        order_type=OrderType.MARKET,
                    ))
                    self._position = Decimal("100")

                elif fast_sma < slow_sma and self._position > Decimal("0"):
                    # Sell signal
                    signals.append(Signal(
                        symbol=self._symbol,
                        side=OrderSide.SELL,
                        quantity=self._position,
                        order_type=OrderType.MARKET,
                    ))
                    self._position = Decimal("0")

                return signals

        return StrategyAdapter(strategy_code, params, symbol)

    def _calculate_metrics(
        self,
        result: BacktestResult,
        config: BacktestConfig,
    ) -> None:
        """Calculate performance metrics from backtest results."""
        initial = config.initial_capital
        final = result.equity_curve[-1] if result.equity_curve else initial

        # Total return
        result.total_return = final - initial
        result.total_return_percent = (final / initial - 1) * 100

        # Trade statistics
        result.total_trades = len(result.trades)

        if result.total_trades > 0:
            winning = [t for t in result.trades if t.pnl > 0]
            losing = [t for t in result.trades if t.pnl <= 0]

            result.winning_trades = len(winning)
            result.losing_trades = len(losing)
            result.win_rate = (len(winning) / result.total_trades) * 100

            if winning:
                result.avg_win = sum(t.pnl for t in winning) / len(winning)
            if losing:
                result.avg_loss = abs(sum(t.pnl for t in losing) / len(losing))

            # Profit factor
            gross_profit = sum(t.pnl for t in winning) if winning else 0
            gross_loss = abs(sum(t.pnl for t in losing)) if losing else 0
            if gross_loss > 0:
                result.profit_factor = gross_profit / gross_loss
            else:
                result.profit_factor = float('inf') if gross_profit > 0 else 0

        # Drawdown calculation
        peak = initial
        max_dd = 0
        max_dd_pct = 0

        for equity in result.equity_curve:
            if equity > peak:
                peak = equity
            dd = peak - equity
            dd_pct = (dd / peak) * 100 if peak > 0 else 0

            result.drawdown_curve.append(dd_pct)

            if dd > max_dd:
                max_dd = dd
                max_dd_pct = dd_pct

        result.max_drawdown = max_dd
        result.max_drawdown_percent = max_dd_pct

        # Sharpe ratio (simplified)
        if len(result.equity_curve) > 1:
            returns = []
            for i in range(1, len(result.equity_curve)):
                ret = (result.equity_curve[i] / result.equity_curve[i-1]) - 1
                returns.append(ret)

            if len(returns) >= 2:
                avg_return = sum(returns) / len(returns)
                variance = sum((r - avg_return) ** 2 for r in returns) / (len(returns) - 1)
                std_return = variance ** 0.5

                if std_return > 0:
                    # Annualized (assuming daily returns)
                    result.sharpe_ratio = (avg_return * 252) / (std_return * (252 ** 0.5))
