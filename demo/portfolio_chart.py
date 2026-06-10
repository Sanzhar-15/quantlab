"""Portfolio equity curve with moving-average overlays.

Demo: open this file, then press Ctrl+Q Shift+C ("Open as Chart"),
and pick demo/portfolio.csv as the data source.
"""


def visualize(chart):
    """Plot the portfolio close with fast/slow moving averages."""
    fast_ma = ql.sma(data.close, period=10)
    slow_ma = ql.sma(data.close, period=30)
    chart.plot(data.close, color="blue", label="Portfolio")
    chart.plot(fast_ma, color="green", label="SMA 10")
    chart.plot(slow_ma, color="red", label="SMA 30")
