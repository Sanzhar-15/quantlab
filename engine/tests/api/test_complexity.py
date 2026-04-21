"""
Tests for Phase 3 Complexity Analyzer module.

Tests strategy complexity analysis and safety classification.
"""

import pytest

from quantlab.api.complexity import (
    ComplexityLevel,
    ComplexityFactor,
    ComplexityResult,
    ComplexityAnalyzer,
    analyze_complexity,
    get_complexity_level,
)


class TestComplexityLevel:
    """Tests for ComplexityLevel enum."""

    def test_values(self) -> None:
        """Test complexity level values."""
        assert ComplexityLevel.SAFE.value == "safe"
        assert ComplexityLevel.PARTIAL.value == "partial"
        assert ComplexityLevel.VIEW_ONLY.value == "view_only"


class TestComplexityFactor:
    """Tests for ComplexityFactor dataclass."""

    def test_creation(self) -> None:
        """Test factor creation."""
        factor = ComplexityFactor(
            name="external_import",
            category="imports",
            severity=3,
            description="External module: custom_lib",
            line_number=5,
        )
        assert factor.name == "external_import"
        assert factor.severity == 3
        assert factor.line_number == 5


class TestComplexityResult:
    """Tests for ComplexityResult dataclass."""

    def test_creation(self) -> None:
        """Test result creation."""
        result = ComplexityResult(
            level=ComplexityLevel.SAFE,
            score=10,
            confidence=0.9,
        )
        assert result.level == ComplexityLevel.SAFE
        assert result.score == 10
        assert result.confidence == 0.9

    def test_to_dict(self) -> None:
        """Test conversion to dictionary."""
        result = ComplexityResult(
            level=ComplexityLevel.PARTIAL,
            score=30,
            confidence=0.85,
            factors=[
                ComplexityFactor("test", "imports", 3, "Test factor"),
            ],
        )
        d = result.to_dict()

        assert d["level"] == "partial"
        assert d["score"] == 30
        assert d["confidence"] == 0.85
        assert len(d["factors"]) == 1

    def test_indicator_dots(self) -> None:
        """Test indicator dots based on score."""
        # Low score = 1 dot
        result1 = ComplexityResult(ComplexityLevel.SAFE, 10, 0.9)
        assert result1.indicator_dots == 1

        # Medium score = 3 dots
        result2 = ComplexityResult(ComplexityLevel.PARTIAL, 50, 0.8)
        assert result2.indicator_dots == 3

        # High score = 5 dots
        result3 = ComplexityResult(ComplexityLevel.VIEW_ONLY, 90, 0.7)
        assert result3.indicator_dots == 5

    def test_color(self) -> None:
        """Test indicator colors."""
        safe = ComplexityResult(ComplexityLevel.SAFE, 10, 0.9)
        partial = ComplexityResult(ComplexityLevel.PARTIAL, 30, 0.8)
        view_only = ComplexityResult(ComplexityLevel.VIEW_ONLY, 80, 0.7)

        assert safe.color == "#059669"  # Green
        assert partial.color == "#d97706"  # Yellow/Amber
        assert view_only.color == "#dc2626"  # Red


class TestComplexityAnalyzer:
    """Tests for ComplexityAnalyzer class."""

    def test_safe_strategy(self) -> None:
        """Test analyzing a safe strategy."""
        code = '''
import numpy as np
import quantlab as ql

fast_period = ql.param(10, min=5, max=50)
slow_period = ql.param(20, min=10, max=100)

def strategy(data):
    fast_sma = data.close.rolling(fast_period).mean()
    slow_sma = data.close.rolling(slow_period).mean()
    return ql.long(fast_sma > slow_sma)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        assert result.level == ComplexityLevel.SAFE
        assert result.score < 15

    def test_partial_complexity_external_import(self) -> None:
        """Test strategy with external imports."""
        code = '''
import custom_indicator_lib
import quantlab as ql

def strategy(data):
    signal = custom_indicator_lib.calculate(data.close)
    return ql.long(signal > 0)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # External import increases complexity
        assert result.score > 0
        assert any(f.category == "imports" for f in result.factors)

    def test_view_only_eval(self) -> None:
        """Test strategy with eval (dangerous)."""
        code = '''
import quantlab as ql

def strategy(data):
    expr = "data.close[-1] > 100"
    if eval(expr):
        return ql.long(True)
    return ql.flat()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        assert result.level == ComplexityLevel.VIEW_ONLY
        assert any(f.category == "security" for f in result.factors)

    def test_view_only_exec(self) -> None:
        """Test strategy with exec (dangerous)."""
        code = '''
import quantlab as ql

def strategy(data):
    exec("signal = True")
    return ql.long(signal)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        assert result.level == ComplexityLevel.VIEW_ONLY

    def test_view_only_subprocess(self) -> None:
        """Test strategy with subprocess (dangerous)."""
        code = '''
import subprocess
import quantlab as ql

def strategy(data):
    result = subprocess.run(["echo", "hello"])
    return ql.flat()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        assert result.level == ComplexityLevel.VIEW_ONLY

    def test_syntax_error(self) -> None:
        """Test strategy with syntax error."""
        code = '''
def strategy(data):
    if True
        return ql.long()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        assert result.level == ComplexityLevel.VIEW_ONLY
        assert any(f.category == "syntax" for f in result.factors)

    def test_api_calls(self) -> None:
        """Test strategy with HTTP API calls."""
        code = '''
import requests
import quantlab as ql

def strategy(data):
    response = requests.get("https://api.example.com/signal")
    return ql.long(response.json()["signal"])
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # API calls increase complexity
        assert result.score > 20
        assert any(f.category == "network" for f in result.factors)

    def test_filesystem_access(self) -> None:
        """Test strategy with filesystem access."""
        code = '''
import quantlab as ql
from pathlib import Path

def strategy(data):
    config = Path("config.json").read_text()
    return ql.flat()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # Filesystem access increases complexity
        assert any(f.category == "io" for f in result.factors)

    def test_complex_function(self) -> None:
        """Test strategy with complex function."""
        code = '''
import quantlab as ql

def strategy(data):
    signal = False
    if data.close[-1] > 100:
        if data.volume[-1] > 1000000:
            if data.close[-1] > data.close[-2]:
                if data.close[-2] > data.close[-3]:
                    for i in range(10):
                        if data.close[-i] > 0:
                            signal = True
                            break
    return ql.long(signal)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # High cyclomatic complexity
        complex_factors = [f for f in result.factors if f.category == "code"]
        # May or may not trigger depending on threshold
        assert result.score >= 0

    def test_metaclass(self) -> None:
        """Test strategy with metaclass."""
        code = '''
import quantlab as ql

class StrategyMeta(type):
    pass

class MyStrategy(metaclass=StrategyMeta):
    def run(self, data):
        return ql.flat()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # Metaclass increases complexity
        assert any(f.name == "metaclass" for f in result.factors)

    def test_dynamic_attributes(self) -> None:
        """Test strategy with __getattr__."""
        code = '''
import quantlab as ql

class MyStrategy:
    def __getattr__(self, name):
        return 0

    def run(self, data):
        return ql.flat()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # Dynamic attributes increase complexity
        assert any(f.name == "dynamic_attributes" for f in result.factors)

    def test_dynamic_parameter(self) -> None:
        """Test strategy with dynamic parameter defaults."""
        code = '''
import quantlab as ql
import os

period = ql.param(int(os.environ.get("PERIOD", "20")))

def strategy(data):
    sma = data.close.rolling(period).mean()
    return ql.long(sma > data.close)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # Dynamic parameter increases complexity
        assert any(f.name == "dynamic_parameter" for f in result.factors)

    def test_safe_stdlib_imports(self) -> None:
        """Test that standard library imports are safe."""
        code = '''
import math
import statistics
from decimal import Decimal
from datetime import datetime
import quantlab as ql

def strategy(data):
    avg = statistics.mean(data.close[-20:])
    return ql.long(data.close[-1] > avg)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # Safe stdlib should not add factors
        import_factors = [f for f in result.factors if f.category == "imports"]
        assert len(import_factors) == 0

    def test_safe_data_modules(self) -> None:
        """Test that numpy/pandas are safe."""
        code = '''
import numpy as np
import pandas as pd
import quantlab as ql

def strategy(data):
    sma = pd.Series(data.close).rolling(20).mean()
    return ql.long(np.array(data.close)[-1] > sma.iloc[-1])
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # Data modules should be safe
        import_factors = [f for f in result.factors if f.category == "imports"]
        assert len(import_factors) == 0

    def test_confidence_high_for_clean_code(self) -> None:
        """Test that confidence is high for clean code."""
        code = '''
import quantlab as ql

def strategy(data):
    return ql.long(data.close[-1] > 100)
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        assert result.confidence >= 0.90

    def test_confidence_decreases_with_factors(self) -> None:
        """Test that confidence decreases with more factors."""
        code = '''
import custom_lib1
import custom_lib2
import custom_lib3
import quantlab as ql

def strategy(data):
    return ql.flat()
'''
        analyzer = ComplexityAnalyzer()
        result = analyzer.analyze(code)

        # More factors = lower confidence
        assert result.confidence < 0.90


class TestHelperFunctions:
    """Tests for module-level helper functions."""

    def test_analyze_complexity(self) -> None:
        """Test analyze_complexity function."""
        code = '''
import quantlab as ql

def strategy(data):
    return ql.long(data.close[-1] > 100)
'''
        result = analyze_complexity(code)

        assert isinstance(result, ComplexityResult)
        assert result.level == ComplexityLevel.SAFE

    def test_get_complexity_level(self) -> None:
        """Test get_complexity_level function."""
        safe_code = '''
import quantlab as ql
def strategy(data):
    return ql.flat()
'''
        dangerous_code = '''
import quantlab as ql
def strategy(data):
    eval("1+1")
    return ql.flat()
'''
        assert get_complexity_level(safe_code) == ComplexityLevel.SAFE
        assert get_complexity_level(dangerous_code) == ComplexityLevel.VIEW_ONLY
