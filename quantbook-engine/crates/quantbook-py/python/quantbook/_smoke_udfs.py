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


quantbook.register_formula_function(_double, handle=7)
quantbook.register_formula_function(_echo, handle=8)
quantbook.register_formula_function(_raise_value_error, handle=9)
quantbook.register_formula_function(_slow, handle=11)
