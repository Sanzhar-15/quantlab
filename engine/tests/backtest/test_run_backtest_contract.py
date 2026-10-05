"""
The backtest CLI's result contract (quantlab/cli/run_backtest.py convert_results): no metric is made up.
"""

from types import SimpleNamespace

import pytest

from quantlab.cli.run_backtest import convert_results


def _metrics(**overrides):
    fields = dict(sharpe_ratio=1.5, sortino_ratio=2.0, total_return_pct=3.25, max_drawdown_pct=1.1,
                  win_rate=60.0, profit_factor=None, calmar_ratio=0.9, total_trades=4)
    fields.update(overrides)
    return SimpleNamespace(**fields)


def _results(metrics, warnings=None):
    return SimpleNamespace(metrics=metrics, warnings=list(warnings or []), equity_curve=[], fills=[],
                           trades=[{"pnl": 1}], total_return_pct=7.5)


def test_no_metrics_is_a_named_failure_carrying_the_runner_warnings():
    with pytest.raises(ValueError, match=r"no performance metrics \(equity curve: 0 point\(s\); runner warnings: \['low liquidity'\]\)"):
        convert_results(_results(None, ["low liquidity"]), "job-1")


def test_return_and_trades_are_never_made_up_from_other_fields():
    out = convert_results(_results(_metrics(total_return_pct=None, total_trades=None)), "job-1")
    assert "Return" not in out["metrics"]
    assert "Trades" not in out["metrics"]
    assert out["metrics"]["Sharpe"] == 1.5


def test_a_complete_result_carries_every_field_and_the_warnings_as_given():
    out = convert_results(_results(_metrics(), ["low liquidity"]), "job-1")
    assert set(out) == {"success", "metrics", "warnings", "equity", "signals"}
    assert out["success"] is True
    assert out["warnings"] == ["low liquidity"]
    assert out["metrics"]["Return"] == 3.25 and out["metrics"]["Trades"] == 4
    assert "ProfitFactor" not in out["metrics"]
