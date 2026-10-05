"""
A metrics calculator exception is the backtest's named failure (quantlab/backtest/runner.py), never a warning
on a result without metrics; the CLI reports it as the job's error.
"""

import datetime
import io
import json
import math
from pathlib import Path

import pytest

from quantlab.backtest import runner
from quantlab.cli import run_backtest

STRATEGY = Path(__file__).resolve().parent.parent / "fixtures" / "sample_strategy_sma_crossover.py"


@pytest.fixture
def bars_csv(tmp_path):
    """60 valid weekday bars (low <= open, close <= high), enough for the strategy's SMA 10/20 crossovers."""
    path = tmp_path / "bars.csv"
    lines = ["date,open,high,low,close,volume"]
    day = datetime.date(2025, 1, 1)
    while len(lines) <= 60:
        if day.weekday() < 5:
            n = len(lines) - 1
            c = 100 + 10 * math.sin(n / 9) + n * 0.05
            lines.append(f"{day.isoformat()},{c - 0.5:.2f},{c + 1:.2f},{c - 1:.2f},{c:.2f},{1000000 + n * 100}")
        day += datetime.timedelta(days=1)
    path.write_text("\n".join(lines) + "\n")
    return path


def _raise_boom(self, *args, **kwargs):
    raise ZeroDivisionError("boom")


def test_the_run_reaches_the_calculator_and_has_metrics(bars_csv):
    results = runner.backtest(strategy=STRATEGY, data=bars_csv)
    assert len(results.equity_curve) > 1
    assert results.metrics is not None


def test_a_calculator_exception_is_a_named_failure(monkeypatch, bars_csv):
    monkeypatch.setattr(runner.MetricsCalculator, "calculate", _raise_boom)
    with pytest.raises(Exception) as caught:
        runner.backtest(strategy=STRATEGY, data=bars_csv)
    assert type(caught.value).__name__ == "MetricsCalculationError"
    assert str(caught.value) == "metrics calculation failed: boom"
    assert isinstance(caught.value.__cause__, ZeroDivisionError)


def test_the_cli_reports_the_calculator_exception_as_the_job_error(monkeypatch, capsys, bars_csv):
    monkeypatch.setattr(runner.MetricsCalculator, "calculate", _raise_boom)
    config = {"jobId": "job-metrics", "strategyPath": str(STRATEGY), "mode": "backtest", "symbol": "",
              "timeframe": "", "dateStart": None, "dateEnd": None, "dataSource": str(bars_csv),
              "initialCapital": 100000, "commission": 0.001, "positionSize": 100, "params": {}}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(config)))
    with pytest.raises(SystemExit) as exited:
        run_backtest.main()
    assert exited.value.code == 1
    out = json.loads(capsys.readouterr().out)
    assert out["success"] is False
    assert out["error"] == "metrics calculation failed: boom"
