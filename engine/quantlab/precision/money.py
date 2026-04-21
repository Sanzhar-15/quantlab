"""
Monetary Precision Helpers (NEW-ENG-006).

Prevents floating-point penny errors in cash and equity calculations
by quantizing Decimal amounts to standard precisions.

Spec Reference: Technical Spec §4.1
"""

from decimal import Decimal, ROUND_HALF_UP

# Standard precisions
DOLLAR_PRECISION = Decimal("0.01")        # Cents
SHARE_PRECISION = Decimal("0.0001")       # Fractional shares (4 dp)
PRICE_PRECISION = Decimal("0.0001")       # Price calculations (4 dp)
RATE_PRECISION = Decimal("0.000001")      # Interest / borrow rates (6 dp)


def quantize_dollars(amount: Decimal) -> Decimal:
    """Round a dollar amount to the nearest cent.

    Prevents floating-point drift such as $99.99999999 instead of $100.00.
    """
    return amount.quantize(DOLLAR_PRECISION, rounding=ROUND_HALF_UP)


def quantize_price(price: Decimal) -> Decimal:
    """Round price to 4 decimal places."""
    return price.quantize(PRICE_PRECISION, rounding=ROUND_HALF_UP)


def quantize_shares(quantity: Decimal) -> Decimal:
    """Round share quantity to 4 decimal places (fractional shares)."""
    return quantity.quantize(SHARE_PRECISION, rounding=ROUND_HALF_UP)
