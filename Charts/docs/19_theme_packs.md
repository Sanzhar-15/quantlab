# Theme Packs

Charts+ ships curated, opt-in theme presets for consistent styling across demos and exports.

## Presets

- `atlas-dark` (default look)
- `atlas-neutral` (softer contrast, cooler palette)
- `atlas-light` (bright, print-friendly)

## Usage

```ts
import { getThemePreset, type ThemePresetName } from '@charts-plus/chart-core/presets';

const theme = getThemePreset('atlas-neutral');
chart.setTheme(theme);
```

## Notes

- Presets live in `packages/chart-core/src/presets.ts` and are exposed via an optional entrypoint.
- `DEFAULT_THEME_TOKENS` stays unchanged; presets are opt-in.
- PNG export uses the active theme tokens.
