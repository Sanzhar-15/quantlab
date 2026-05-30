"""Smoke-test UDF fixture — registers a few functions by handle for the
`ql-udf` `process_smoke` integration test (`QUANTBOOK_UDF_MODULE=quantbook._smoke_udfs`).
Not part of the product surface."""

import time

import quantbook


def _double(args):
    """handle 7 — double a single numeric arg (1x1 grid in → scalar out)."""
    return args.get(0, 0) * 2.0


def _echo(args):
    """handle 8 — identity over the whole args grid (round-trip fidelity check)."""
    return args


def _raise_value_error(args):
    """handle 9 — always raises (exercises the RAISE path)."""
    raise ValueError("intentional smoke failure")


def _slow(args):
    """handle 11 — sleeps far longer than any test deadline (exercises timeout-kill)."""
    time.sleep(60)
    return 0.0


# --- 6.4B (UDF-6-03) type-conversion matrix fixtures ---------------------------
# numpy/pandas are imported LAZILY inside each function so this module still
# imports on an interpreter that has only `pyarrow` (the core round-trip matrix
# never touches numpy/pandas). The Rust test guards each case on the relevant
# library being importable, so a missing import never masquerades as the
# type-boundary `TypeError` these fixtures are meant to surface.


def _return_numpy_float64(args):
    """handle 20 — returns `numpy.float64` (a Python `float` SUBCLASS → encodes as
    `Value::Number`, the one numpy scalar that round-trips)."""
    import numpy as np

    return np.float64(2.5)


def _return_numpy_int64(args):
    """handle 21 — returns `numpy.int64` (NOT an `int`/`float` subclass → the
    encoder rejects it with `TypeError`; no silent coercion)."""
    import numpy as np

    return np.int64(7)


def _return_numpy_bool(args):
    """handle 22 — returns `numpy.bool_` (NOT a `bool`/`int` subclass → `TypeError`)."""
    import numpy as np

    return np.bool_(True)


def _return_pandas_series(args):
    """handle 23 — returns a `pandas.Series` (unsupported cell type → `TypeError`)."""
    import pandas as pd

    return pd.Series([1.0, 2.0])


def _return_pandas_dataframe(args):
    """handle 24 — returns a `pandas.DataFrame` (unsupported cell type → `TypeError`)."""
    import pandas as pd

    return pd.DataFrame({"a": [1.0, 2.0]})


quantbook.register_formula_function(_double, handle=7)
quantbook.register_formula_function(_echo, handle=8)
quantbook.register_formula_function(_raise_value_error, handle=9)
quantbook.register_formula_function(_slow, handle=11)
quantbook.register_formula_function(_return_numpy_float64, handle=20)
quantbook.register_formula_function(_return_numpy_int64, handle=21)
quantbook.register_formula_function(_return_numpy_bool, handle=22)
quantbook.register_formula_function(_return_pandas_series, handle=23)
quantbook.register_formula_function(_return_pandas_dataframe, handle=24)
