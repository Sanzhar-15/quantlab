"""
Test validation logic without external dependencies.
"""

import re

# Validation patterns - MUST match StrategyValidator.ts exactly
VECTOR_PATTERN = re.compile(r'def\s+strategy\s*\(\s*data\s*\)')
EVENT_PATTERN = re.compile(r'def\s+on_bar\s*\(\s*ctx\s*\)')
CLASS_PATTERN = re.compile(r'class\s+(\w+)\s*\(\s*ql\.Strategy\s*\)')

def detect_entrypoint(code: str):
    """Detect strategy entrypoint."""
    if VECTOR_PATTERN.search(code):
        return ('vectorized', 'strategy')
    if EVENT_PATTERN.search(code):
        return ('eventDriven', 'on_bar')
    match = CLASS_PATTERN.search(code)
    if match:
        return ('classBased', match.group(1))
    return None

# Test cases
test_cases = [
    # Valid vectorized
    {
        'name': 'Valid vectorized strategy',
        'code': 'import quantlab as ql\n\ndef strategy(data):\n    return ql.Signals()',
        'expected': ('vectorized', 'strategy')
    },
    # Valid event-driven
    {
        'name': 'Valid event-driven strategy',
        'code': 'import quantlab as ql\n\ndef on_bar(ctx):\n    pass',
        'expected': ('eventDriven', 'on_bar')
    },
    # Valid class-based
    {
        'name': 'Valid class-based strategy',
        'code': 'import quantlab as ql\n\nclass MyStrategy(ql.Strategy):\n    def on_bar(self, ctx):\n        pass',
        'expected': ('classBased', 'MyStrategy')
    },
    # Invalid - type hints
    {
        'name': 'Invalid - type hints in signature',
        'code': 'import quantlab as ql\n\ndef strategy(data: pd.DataFrame):\n    return ql.Signals()',
        'expected': None
    },
    # Invalid - wrong class parent
    {
        'name': 'Invalid - class without ql.Strategy parent',
        'code': 'class MyStrategy:\n    def on_bar(self, ctx):\n        pass',
        'expected': None
    },
    # Valid - extra spaces are tolerated
    {
        'name': 'Valid - handles extra spaces correctly',
        'code': 'def strategy  (  data  ):  pass',
        'expected': ('vectorized', 'strategy')  # Regex allows flexible spacing
    },
    # Valid - exact spacing
    {
        'name': 'Valid - exact spacing',
        'code': 'def strategy(data):  pass',
        'expected': ('vectorized', 'strategy')
    }
]

print("Running validation pattern tests...\n")
passed = 0
failed = 0

for test in test_cases:
    result = detect_entrypoint(test['code'])

    if result == test['expected']:
        passed += 1
        status = "✓"
        if result:
            print(f"{status} {test['name']}: {result[0]} ({result[1]})")
        else:
            print(f"{status} {test['name']}: No entrypoint (expected)")
    else:
        failed += 1
        status = "✗"
        print(f"{status} {test['name']}")
        print(f"  Expected: {test['expected']}")
        print(f"  Got: {result}")

print(f"\n{passed} passed, {failed} failed")

if failed == 0:
    print("\n✅ All validation patterns working correctly!")
else:
    print(f"\n❌ {failed} tests failed")
