"""
Decimal precision module.

Provides:
- PrecisionPolicy class for asset-class-specific precision
- Comparison tolerance helpers
- Rounding rules (HALF_UP for equity, DOWN for crypto)

All prices and quantities MUST use Decimal, not float.
"""
