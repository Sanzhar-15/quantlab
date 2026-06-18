/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// FE-3 / Wave D formula-TEXT coloring -- the PURE, vscode/DOM-free transform that partitions an edited
// formula into consecutive coloured/default text SEGMENTS, so a decorative overlay can tint each cell/range
// reference substring with its own colour (Excel's coloured formula tokens). It is the text-side companion
// of the w81 grid colour-boxes: it consumes the SAME `computeFormulaRefHighlights` scanner (which already
// carries each ref's `[start, end)` SOURCE-TEXT span + a stable `colorIndex`, built for exactly this wave)
// and re-expresses it as an ordered, gap-filled list covering the WHOLE string.
//
// SCOPE (v1, matches the grid boxes): only UNQUALIFIED same-sheet refs (`colorIndex >= 0`) are coloured; a
// sheet-qualified ref (`Sheet1!A1`, `colorIndex: -1`) is NOT coloured -- it folds into a default-colour gap
// (deferred as tracker R3b). The coverage invariant below is what keeps a future qualified-colouring change
// honest.
//
// THE COVERAGE INVARIANT (the alignment contract): `buildFormulaInkSegments(t).map(s => s.text).join('')
// === t` for every formula `t`. The overlay renders these segments verbatim over a transparent `<input>`;
// if the concatenated segment text ever diverged from the input value by even one char, every colour past
// the divergence would slide off its glyph. So this module emits each source character exactly once, in
// order, and never fabricates or drops one. The unit tests assert the invariant across the whole corpus.
//
// No-Fallbacks: like its scanner, this is total -- it relies on `computeFormulaRefHighlights` returning
// highlights in increasing-`start`, non-overlapping order (its documented, tested contract). It does not
// silently repair a contract break; it skips any highlight that would re-cover an already-emitted region
// (which cannot happen per contract) so the coverage invariant is preserved rather than duplicating chars.

import { computeFormulaRefHighlights } from './formulaRefHighlights';

/**
 * One run of formula text that renders in a single colour.
 *   - `text` is the verbatim source slice (never empty).
 *   - `colorIndex` is the reference's RAW (unbounded) distinct-target colour slot (`>= 0`); the RENDERER
 *     takes it MODULO its palette length (the value itself is NOT pre-modulo'd -- it keeps climbing past the
 *     palette size, identical to the `computeFormulaRefHighlights` contract), so a ref's text colour matches
 *     its grid box at `canvasGrid.drawRefHighlights`. `-1` means DEFAULT editor-foreground text (operators,
 *     whitespace, the leading `=`, string literals, function names, number literals, and -- v1 -- a
 *     sheet-qualified ref).
 */
export interface InkSegment {
	readonly text: string;
	readonly colorIndex: number;
}

/**
 * Partition an edited formula into consecutive {@link InkSegment}s for the text-colouring overlay.
 *
 * Returns `[]` when `text` is empty or is not a formula (`text[0] !== '='`) -- the SIGNAL the caller uses to
 * disable the overlay entirely (the `<input>` then renders its own opaque text). Otherwise returns one or
 * more segments that, concatenated, reproduce `text` exactly (the coverage invariant): a coloured segment
 * for each drawable (`colorIndex >= 0`) reference's source span, and a default-colour (`-1`) segment for
 * every gap between/around them (incl. a sheet-qualified ref, which v1 leaves uncoloured -- tracker R3b).
 *
 * Pure + total (never throws); mirrors the `computeFormulaRefHighlights` totality on a malformed body.
 */
export function buildFormulaInkSegments(text: string): InkSegment[] {
	if (text.length === 0 || text[0] !== '=') {
		return []; // not a formula -> the overlay stays off and the input shows its normal opaque text
	}
	const out: InkSegment[] = [];
	let cursor = 0;
	for (const h of computeFormulaRefHighlights(text)) {
		// Skip a non-drawable ref (qualified `Sheet1!A1` -> colorIndex -1; rendered as default-colour gap
		// text below) AND any highlight that starts before the cursor (an out-of-order / overlapping ref --
		// impossible per the scanner's sorted, non-overlapping contract; skipping rather than re-slicing
		// keeps the coverage invariant exact instead of duplicating an already-emitted char).
		if (h.colorIndex < 0 || h.start < cursor) {
			continue;
		}
		if (h.start > cursor) {
			out.push({ text: text.slice(cursor, h.start), colorIndex: -1 }); // the default-colour gap before this ref
		}
		out.push({ text: text.slice(h.start, h.end), colorIndex: h.colorIndex });
		cursor = h.end;
	}
	if (cursor < text.length) {
		out.push({ text: text.slice(cursor), colorIndex: -1 }); // the trailing default-colour remainder
	}
	return out;
}
