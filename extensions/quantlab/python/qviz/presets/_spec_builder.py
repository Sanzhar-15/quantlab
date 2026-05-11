"""Assemble a canonical QvizSpec dict from preset-supplied pieces.

The TypeScript validator at `src/qviz/validate.ts` is strict about field
shapes and rejects anything it doesn't recognize. This builder keeps the
preset code free of repetitive plumbing while ensuring every string
flowing into the spec passes the validator's isAcceptableString rules
(MAX 4 KiB, no NUL, no C0 control except \\t \\n \\r) at the Python call
site — so the editor never refuses a preset-emitted spec on open.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from ._common import (
    QVIZ_SCHEMA_VERSION,
    build_provenance,
    check_acceptable_string,
    write_text_atomic,
)


def build_qviz_spec(
    *,
    dataset: dict[str, Any],
    chart: dict[str, Any],
    generator: str,
    transforms: list[dict[str, Any]] | None = None,
    title: str | None = None,
    description: str | None = None,
    trading_options: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Compose the canonical QvizSpec dict for write_spec()."""
    # Empty-string title/description are treated as "omit." Users who
    # really want an empty title can pass title=" " (space). This matches
    # the typical Python convention `if title:` for human-facing text.
    if title is not None and title != "":
        check_acceptable_string(title, "title", allow_empty=False)
    else:
        title = None
    if description is not None and description != "":
        check_acceptable_string(description, "description", allow_empty=False)
    else:
        description = None
    if trading_options is not None:
        _validate_trading_options(trading_options)

    spec: dict[str, Any] = {
        "$schema": "https://quantlab/schemas/qviz/v1.json",
        "qviz_version": QVIZ_SCHEMA_VERSION,
        "dataset": dataset,
        "transforms": list(transforms) if transforms else [],
        "chart": chart,
        "provenance": build_provenance(generator),
    }
    if title is not None:
        spec["title"] = title
    if description is not None:
        spec["description"] = description
    if trading_options:
        spec["trading_options"] = trading_options
    return spec


def _validate_trading_options(opts: dict[str, Any]) -> None:
    """Check the string fields under trading_options.

    The TS validator only requires shape (timezone: optional string,
    session: optional enum, etc); we additionally pre-check strings for
    isAcceptableString and the session enum, so an editor-load failure
    can never surface from a preset that wrote a malformed value.
    """
    tz = opts.get("timezone")
    if tz is not None:
        check_acceptable_string(tz, "trading_options.timezone", allow_empty=False)
    session = opts.get("session")
    if session is not None and session not in ("regular", "extended", "full24"):
        raise ValueError(
            f"trading_options.session must be one of "
            f"('regular', 'extended', 'full24'), got {session!r}"
        )
    currency = opts.get("currency")
    if currency is not None:
        check_acceptable_string(currency, "trading_options.currency", allow_empty=False)
    adjustment = opts.get("adjustment")
    if adjustment is not None and adjustment not in (
        "none", "split", "dividend", "split-dividend",
    ):
        raise ValueError(
            f"trading_options.adjustment must be one of "
            f"('none', 'split', 'dividend', 'split-dividend'), got {adjustment!r}"
        )


def write_spec(spec: dict[str, Any], spec_path: Path) -> None:
    """Write a QvizSpec dict to `spec_path` as JSON atomically.

    Tab indent mirrors the project's example specs at
    `src/qviz/examples/*.qviz.json`. UTF-8, no BOM, trailing newline.
    `default=str` only triggers if a future code path embeds a Path /
    numpy scalar / pyarrow type; the current preset surface never reaches
    it, but the safety net costs nothing.
    """
    text = json.dumps(spec, indent="\t", ensure_ascii=False, default=str) + "\n"
    write_text_atomic(text, spec_path)
