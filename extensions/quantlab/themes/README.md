# Delta Plus generated themes

`extensions/theme-defaults/themes/delta_plus_{dark,light,hc}.json` are GENERATED. Do not edit them by hand.

## Regenerate / check

    node extensions/quantlab/themes/generate.mjs          # writes the three files
    node extensions/quantlab/themes/generate.mjs --check  # exit 0 only if shipped files are byte-equal to a regeneration

Plain Node ESM, no dependencies, no network. Every problem is a hard error that names the offender
(`BLOB-MISMATCH`, `TOKEN-MISSING`, `TOKEN-NOT-COLOUR`, `TOKEN-CYCLE`, `MAPPING-INVALID`, `COLOUR-INVALID`); there are no fallbacks.

## Inputs (all committed here)

- `tokens/variables.css.template` (named `.template` so the fork hygiene unicode filter skips this byte copy): byte copy of the Delta Plus design tokens, `packages/ui/src/tokens/variables.css.template`.
- `tokens/SOURCE.json`: client commit and git blob sha of that file. The generator recomputes the blob sha
  (sha1 of `"blob <len>\0" + bytes`) and refuses to run if it differs.
- `mapping.json`: VS Code workbench colour id -> token, per theme (`dark`, `light`, `hc`). An entry is `"--token"`,
  `{ "token": "--x", "alpha": 0.4 }` (alpha multiplies the token's own alpha) or `{ "literal": "#rrggbb", "reason": "..." }`
  (explicit and rare). Dark and HC resolve in `:root`; light resolves in `:root` overlaid by the light block.
- `base/{dark,light,hc}.json`: syntax-token layer (`tokenColors`, `semanticTokenColors`, `semanticHighlighting`) plus the
  base `colors` that `mapping.json` overlays. Made once by `flatten-base.mjs` from the pre-C1 `quantlab_dark.json`,
  `quantlab_light.json` and `hc_black.json` with their `include` chains flattened (recorded in that script's header).
- High contrast: `base/hc.json` colours stay as they were (accessibility theme); `mapping.json` `hc` takes only the
  accent/focus keys (`focusBorder`, `list.highlightForeground`, `progressBar.background`) from `--color-brand`.

## Text contrast (WCAG AA, 4.5:1)

Five pairs the token mapping left below 4.5:1 are mapped to other tokens of the same snapshot (the snapshot itself is untouched):
`input.placeholderForeground` dark `--color-muted` (4.48 -> 5.07 on the input) and light `--color-disabled-text` (4.28 -> 5.46);
light `textLink.foreground` and `textLink.activeForeground` `--series-6` (3.33 -> 5.18 on the editor); light `list.highlightForeground`
`--series-6` (2.92 -> 4.54 on the side bar). The placeholders take the closest neutral token that clears 4.5:1 on that background; the light accent text takes the closest orange token (`--down`, red, is nearer but changes the hue). The
initial-colour maps in `src/vs/workbench/services/themes/common/workbenchThemeService.ts` repeat the placeholder and link values and move with them.

## Moving to a new token revision

1. Copy the new `variables.css` over `tokens/variables.css.template` (read it from the client repo's git blob, not its checkout).
2. Update `tokens/SOURCE.json` (`clientCommit`, `blob` = `git hash-object tokens/variables.css.template`).
3. Run `generate.mjs`; fix any named error in `mapping.json`; run `--check`; commit inputs and outputs together.
