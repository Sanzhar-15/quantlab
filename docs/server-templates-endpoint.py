"""
Reference Implementation: Strategy Templates Endpoint
=====================================================

Deploy this to Delta Plus Server at: GET /v1/strategies/templates

This endpoint provides high-quality, working strategy templates that:
1. Pass Quantlab's strict validation (exact entrypoint patterns)
2. Demonstrate best practices (data checks, indicator usage, visualization)
3. Serve as reference examples for AI generation
4. Cover common strategy patterns (trend-following, mean-reversion, momentum, etc.)

Integration with QIC:
    QIC can fetch templates and use them as few-shot examples when generating
    strategies, improving consistency and quality.
"""

# Template Library
STRATEGY_TEMPLATES = [
    # 1. SMA Crossover (Beginner, Trend-Following, Vectorized)
    {
        "id": "sma-crossover",
        "name": "SMA Crossover",
        "description": "Simple moving average crossover strategy. Buy when fast SMA crosses above slow SMA, sell when it crosses below.",
        "category": "trend-following",
        "difficulty": "beginner",
        "entrypoint": "vectorized",
        "code": """import quantlab as ql

# Parameters
fast_period = ql.param("fast", default=10, min=5, max=50)
slow_period = ql.param("slow", default=20, min=10, max=100)

def strategy(data):
    \"\"\"
    Simple Moving Average Crossover Strategy.

    Buy when fast SMA crosses above slow SMA.
    Sell when fast SMA crosses below slow SMA.
    \"\"\"
    # Calculate moving averages
    fast_sma = data.close.rolling(window=fast_period).mean()
    slow_sma = data.close.rolling(window=slow_period).mean()

    # Generate signals
    signals = ql.Signals()

    # Detect crossovers
    buy_condition = ql.cross_over(fast_sma, slow_sma)
    sell_condition = ql.cross_under(fast_sma, slow_sma)

    signals.buy(buy_condition)
    signals.sell(sell_condition)

    return signals

def visualize(chart, data, params):
    \"\"\"Optional chart visualization.\"\"\"
    fast_p = params.get("fast", 10)
    slow_p = params.get("slow", 20)

    fast_sma = data.close.rolling(window=fast_p).mean()
    slow_sma = data.close.rolling(window=slow_p).mean()

    chart.plot(fast_sma, name=f"SMA({fast_p})", color="blue")
    chart.plot(slow_sma, name=f"SMA({slow_p})", color="orange")
    chart.mark_entries(timestamps=[], prices=[], side="long")
    chart.mark_exits(timestamps=[], prices=[], side="long")
""",
        "parameters": [
            {"id": "fast", "description": "Fast SMA period", "defaultValue": 10, "range": [5, 50]},
            {"id": "slow", "description": "Slow SMA period", "defaultValue": 20, "range": [10, 100]}
        ]
    },

    # 2. RSI Mean Reversion (Beginner, Mean-Reversion, Vectorized)
    {
        "id": "rsi-mean-reversion",
        "name": "RSI Mean Reversion",
        "description": "Classic mean-reversion strategy using RSI. Buy when RSI crosses above oversold level, sell when it crosses below overbought level.",
        "category": "mean-reversion",
        "difficulty": "beginner",
        "entrypoint": "vectorized",
        "code": """import quantlab as ql

# Parameters
rsi_period = ql.param("rsi_period", default=14, min=7, max=28)
oversold = ql.param("oversold", default=30, min=20, max=40)
overbought = ql.param("overbought", default=70, min=60, max=80)

def strategy(data):
    \"\"\"
    RSI Mean Reversion Strategy.

    Buy when RSI crosses above oversold level.
    Sell when RSI crosses below overbought level.
    \"\"\"
    # Calculate RSI
    rsi = ql.rsi(data.close, period=rsi_period)

    # Generate signals
    signals = ql.Signals()
    signals.buy(ql.cross_over(rsi, oversold))
    signals.sell(ql.cross_under(rsi, overbought))

    return signals

def visualize(chart, data, params):
    \"\"\"Visualize RSI with oversold/overbought levels.\"\"\"
    period = params.get("rsi_period", 14)
    os = params.get("oversold", 30)
    ob = params.get("overbought", 70)

    rsi = ql.rsi(data.close, period=period)

    chart.mark_entries(timestamps=[], prices=[], side="long")
    chart.mark_exits(timestamps=[], prices=[], side="long")

    chart.add_pane("rsi", height=0.3)
    chart.plot(rsi, name=f"RSI({period})", pane="rsi", color="purple")
    chart.add_line(os, color="green", style="dashed", label="Oversold")
    chart.add_line(ob, color="red", style="dashed", label="Overbought")
    chart.add_line(50.0, color="gray", style="dotted", label="Midline")
""",
        "parameters": [
            {"id": "rsi_period", "description": "RSI period", "defaultValue": 14, "range": [7, 28]},
            {"id": "oversold", "description": "Oversold threshold", "defaultValue": 30, "range": [20, 40]},
            {"id": "overbought", "description": "Overbought threshold", "defaultValue": 70, "range": [60, 80]}
        ]
    },

    # 3. MACD Momentum (Intermediate, Momentum, Vectorized)
    {
        "id": "macd-momentum",
        "name": "MACD Momentum",
        "description": "MACD crossover strategy. Buy when MACD line crosses above signal line, sell when it crosses below.",
        "category": "momentum",
        "difficulty": "intermediate",
        "entrypoint": "vectorized",
        "code": """import quantlab as ql

# Parameters
fast_period = ql.param("fast", default=12, min=8, max=20)
slow_period = ql.param("slow", default=26, min=20, max=40)
signal_period = ql.param("signal", default=9, min=5, max=15)

def strategy(data):
    \"\"\"
    MACD Crossover Strategy.

    Buy when MACD line crosses above signal line.
    Sell when MACD line crosses below signal line.
    \"\"\"
    # Calculate MACD
    macd_line, signal_line, histogram = ql.macd(
        data.close,
        fast=fast_period,
        slow=slow_period,
        signal=signal_period
    )

    # Generate signals
    signals = ql.Signals()
    signals.buy(ql.cross_over(macd_line, signal_line))
    signals.sell(ql.cross_under(macd_line, signal_line))

    return signals

def visualize(chart, data, params):
    \"\"\"Visualize MACD with signal line.\"\"\"
    fast_p = params.get("fast", 12)
    slow_p = params.get("slow", 26)
    signal_p = params.get("signal", 9)

    macd_line, signal_line, histogram = ql.macd(
        data.close, fast=fast_p, slow=slow_p, signal=signal_p
    )

    chart.mark_entries(timestamps=[], prices=[], side="long")
    chart.mark_exits(timestamps=[], prices=[], side="long")

    chart.add_pane("macd", height=0.3)
    chart.plot(macd_line, name="MACD", pane="macd", color="blue")
    chart.plot(signal_line, name="Signal", pane="macd", color="orange")
    chart.plot(histogram, name="Histogram", pane="macd", color="gray", style="histogram")
    chart.add_line(0.0, color="gray", style="solid", label="Zero")
""",
        "parameters": [
            {"id": "fast", "description": "Fast EMA period", "defaultValue": 12, "range": [8, 20]},
            {"id": "slow", "description": "Slow EMA period", "defaultValue": 26, "range": [20, 40]},
            {"id": "signal", "description": "Signal line period", "defaultValue": 9, "range": [5, 15]}
        ]
    },

    # 4. Bollinger Bands (Intermediate, Mean-Reversion, Vectorized)
    {
        "id": "bollinger-bands",
        "name": "Bollinger Bands",
        "description": "Mean-reversion strategy using Bollinger Bands. Buy when price touches lower band, sell when it touches upper band.",
        "category": "mean-reversion",
        "difficulty": "intermediate",
        "entrypoint": "vectorized",
        "code": """import quantlab as ql

# Parameters
period = ql.param("period", default=20, min=10, max=50)
std_dev = ql.param("std_dev", default=2.0, min=1.5, max=3.0)

def strategy(data):
    \"\"\"
    Bollinger Bands Mean Reversion Strategy.

    Buy when price touches or crosses below lower band.
    Sell when price touches or crosses above upper band.
    \"\"\"
    # Calculate Bollinger Bands
    upper, middle, lower = ql.bbands(data.close, period=period, std=std_dev)

    # Generate signals
    signals = ql.Signals()
    signals.buy(data.close <= lower)  # Price at or below lower band
    signals.sell(data.close >= upper)  # Price at or above upper band

    return signals

def visualize(chart, data, params):
    \"\"\"Visualize Bollinger Bands.\"\"\"
    p = params.get("period", 20)
    std = params.get("std_dev", 2.0)

    upper, middle, lower = ql.bbands(data.close, period=p, std=std)

    chart.plot(upper, name="BB Upper", color="red", style="dashed")
    chart.plot(middle, name=f"SMA({p})", color="blue")
    chart.plot(lower, name="BB Lower", color="green", style="dashed")
    chart.mark_entries(timestamps=[], prices=[], side="long")
    chart.mark_exits(timestamps=[], prices=[], side="long")
""",
        "parameters": [
            {"id": "period", "description": "Moving average period", "defaultValue": 20, "range": [10, 50]},
            {"id": "std_dev", "description": "Standard deviations", "defaultValue": 2.0, "range": [1.5, 3.0]}
        ]
    },

    # 5. Event-Driven Momentum (Intermediate, Momentum, Event-Driven)
    {
        "id": "event-momentum",
        "name": "Event-Driven Momentum",
        "description": "Event-driven strategy that trades on momentum. Buys on significant up-moves, sells on down-moves.",
        "category": "momentum",
        "difficulty": "intermediate",
        "entrypoint": "eventDriven",
        "code": """import quantlab as ql

# Parameters
threshold = ql.param("threshold", default=0.02, min=0.01, max=0.10)
lookback = ql.param("lookback", default=5, min=2, max=10)

def on_bar(ctx):
    \"\"\"
    Event-driven momentum strategy.

    Buys when recent return exceeds threshold.
    Sells when recent return drops below negative threshold.
    \"\"\"
    # Need minimum data
    if len(ctx.data) < lookback + 1:
        return

    # Calculate returns over lookback period
    prev_close = ctx.data.close.iloc[-(lookback + 1)]
    curr_close = ctx.data.close.iloc[-1]
    period_return = (curr_close - prev_close) / prev_close

    symbol = ctx.data.symbol

    # Buy on strong upward momentum
    if period_return > threshold and not ctx.portfolio.has_position(symbol):
        ctx.orders.market_buy(symbol, quantity=100)

    # Sell on strong downward momentum
    if period_return < -threshold and ctx.portfolio.has_position(symbol):
        position = ctx.portfolio.position(symbol)
        ctx.orders.market_sell(symbol, quantity=position.quantity)
""",
        "parameters": [
            {"id": "threshold", "description": "Momentum threshold", "defaultValue": 0.02, "range": [0.01, 0.10]},
            {"id": "lookback", "description": "Lookback period", "defaultValue": 5, "range": [2, 10]}
        ]
    },

    # 6. Class-Based Multi-Timeframe (Advanced, Multi-Indicator, Class-Based)
    {
        "id": "class-multi-indicator",
        "name": "Multi-Indicator System",
        "description": "Advanced class-based strategy combining multiple indicators (SMA, RSI, MACD) for robust signal generation.",
        "category": "multi-indicator",
        "difficulty": "advanced",
        "entrypoint": "classBased",
        "code": """import quantlab as ql

class MultiIndicatorStrategy(ql.Strategy):
    \"\"\"
    Multi-indicator strategy combining SMA, RSI, and MACD.

    Entry: SMA trending up, RSI not overbought, MACD bullish
    Exit: SMA trending down OR RSI overbought
    \"\"\"
    # Parameters
    sma_period = ql.param("sma_period", default=20, min=10, max=50)
    rsi_period = ql.param("rsi_period", default=14, min=7, max=28)
    rsi_overbought = ql.param("rsi_overbought", default=70, min=60, max=80)

    def initialize(self):
        \"\"\"Initialize strategy state.\"\"\"
        pass

    def on_bar(self, ctx):
        \"\"\"Called on each bar.\"\"\"
        for symbol in ctx.universe:
            data = ctx.data[symbol]

            # Need minimum data
            if len(data) < max(self.sma_period, self.rsi_period, 26):
                continue

            # Calculate indicators
            sma = data.close.rolling(window=self.sma_period).mean().iloc[-1]
            sma_prev = data.close.rolling(window=self.sma_period).mean().iloc[-2]
            rsi = ql.rsi(data.close, period=self.rsi_period).iloc[-1]
            macd_line, signal_line, _ = ql.macd(data.close, fast=12, slow=26, signal=9)
            macd_val = macd_line.iloc[-1]
            signal_val = signal_line.iloc[-1]

            current_price = data.close.iloc[-1]
            has_position = ctx.portfolio.has_position(symbol)

            # Entry conditions: all must be true
            sma_trending_up = sma > sma_prev
            rsi_not_overbought = rsi < self.rsi_overbought
            macd_bullish = macd_val > signal_val

            if sma_trending_up and rsi_not_overbought and macd_bullish and not has_position:
                target_value = ctx.portfolio.equity * 0.10
                quantity = int(target_value / current_price)
                if quantity > 0:
                    ctx.orders.market_buy(symbol, quantity=quantity)

            # Exit conditions: any must be true
            sma_trending_down = sma < sma_prev
            rsi_overbought_exit = rsi > self.rsi_overbought

            if (sma_trending_down or rsi_overbought_exit) and has_position:
                position = ctx.portfolio.position(symbol)
                ctx.orders.market_sell(symbol, quantity=position.quantity)
""",
        "parameters": [
            {"id": "sma_period", "description": "SMA period", "defaultValue": 20, "range": [10, 50]},
            {"id": "rsi_period", "description": "RSI period", "defaultValue": 14, "range": [7, 28]},
            {"id": "rsi_overbought", "description": "RSI overbought level", "defaultValue": 70, "range": [60, 80]}
        ]
    }
]


def get_templates_response():
    """
    Get templates response for GET /v1/strategies/templates.

    Returns:
        Dictionary with version and templates list
    """
    return {
        "version": "1.0.0",
        "templates": STRATEGY_TEMPLATES
    }


# FastAPI integration
def setup_templates_endpoint(app):
    """
    Setup templates endpoint in existing FastAPI application.

    Usage:
        from fastapi import FastAPI
        from server_templates_endpoint import setup_templates_endpoint

        app = FastAPI()
        setup_templates_endpoint(app)
    """
    from fastapi import APIRouter

    router = APIRouter(prefix="/v1/strategies", tags=["strategies"])

    @router.get("/templates")
    async def get_strategy_templates():
        """
        Get strategy templates library.

        Returns a collection of high-quality, working strategy templates that:
        - Pass Quantlab's strict validation
        - Demonstrate best practices
        - Cover common strategy patterns
        - Include visualization code

        Example response:
        {
            "version": "1.0.0",
            "templates": [
                {
                    "id": "sma-crossover",
                    "name": "SMA Crossover",
                    "description": "Simple moving average crossover strategy...",
                    "category": "trend-following",
                    "difficulty": "beginner",
                    "entrypoint": "vectorized",
                    "code": "import quantlab as ql\\n\\ndef strategy(data):...",
                    "parameters": [...]
                },
                ...
            ]
        }
        """
        return get_templates_response()

    app.include_router(router)


# Standalone testing
if __name__ == '__main__':
    import json

    response = get_templates_response()
    print(f"Templates version: {response['version']}")
    print(f"Total templates: {len(response['templates'])}\n")

    for template in response['templates']:
        print(f"✓ {template['name']}")
        print(f"  Category: {template['category']}")
        print(f"  Difficulty: {template['difficulty']}")
        print(f"  Entrypoint: {template['entrypoint']}")
        print(f"  Parameters: {len(template['parameters'])}")
        print()

    # Verify all templates have valid code
    print("\nValidating all templates...")
    import re
    VECTOR_PATTERN = re.compile(r'def\s+strategy\s*\(\s*data\s*\)')
    EVENT_PATTERN = re.compile(r'def\s+on_bar\s*\(\s*ctx\s*\)')
    CLASS_PATTERN = re.compile(r'class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)')

    all_valid = True
    for template in response['templates']:
        code = template['code']
        entrypoint = template['entrypoint']

        if entrypoint == 'vectorized' and not VECTOR_PATTERN.search(code):
            print(f"✗ {template['name']}: Missing vectorized entrypoint")
            all_valid = False
        elif entrypoint == 'eventDriven' and not EVENT_PATTERN.search(code):
            print(f"✗ {template['name']}: Missing event-driven entrypoint")
            all_valid = False
        elif entrypoint == 'classBased' and not CLASS_PATTERN.search(code):
            print(f"✗ {template['name']}: Missing class-based entrypoint")
            all_valid = False
        else:
            print(f"✓ {template['name']}: Valid entrypoint")

    if all_valid:
        print("\n✅ All templates have valid entrypoints!")
    else:
        print("\n❌ Some templates have invalid entrypoints")
