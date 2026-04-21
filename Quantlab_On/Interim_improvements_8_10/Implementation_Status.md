# Implementation Status - 2026-01-26

## Changes Made

### 1. Chart Drag Fix - Diagnostic Mode

**File**: `Charts/packages/chart-render-canvas2d/src/index.ts`

#### A. Pan Cache Disabled (Temporary)
- Line ~8123-8148: Set `usePanCache = false`
- This tests if pan cache is the source of the bug
- If chart works with this disabled, the bug is in pan cache logic

#### B. Diagnostic Logging Added
Logs are prefixed with `[PAN]` and appear in DevTools console:

1. **beginPan** (line ~4326): Logs pan start state
   - beforeRange, panBaseRange, panOverscrollPx

2. **applyPanDelta** (line ~4535): Logs pan delta application
   - deltaX, elasticClampEnabled, range before/after

3. **renderSeries** (line ~8125): Logs render state during pan
   - Current range, panBaseRange, panOverscrollPx

4. **Direct rendering** (line ~8288): Logs when direct rendering is used
   - Range, panOffsetPx, plotWidth

### 2. Taskbar Icon Fix

**File**: `~/.local/share/applications/quantlab-dev.desktop`

- Changed `StartupWMClass=Quantlab` to `StartupWMClass=quantlab` (lowercase)
- This matches the `applicationName` in `product.json`
- Desktop database updated

---

## Testing Instructions

### Test 1: Chart Drag (with Pan Cache Disabled)

1. Restart Quantlab (or refresh if hot-reload is active)
2. Open DevTools (Ctrl+Shift+I or Cmd+Option+I)
3. Go to Console tab
4. Open a chart with candlestick data
5. Start dragging the chart
6. **Observe**:
   - Does the initial "zoom out" still happen?
   - Do candlesticks move with the grid now?
   - Check console for `[PAN]` logs

### Expected Console Output
```
[PAN] beginPan: { beforeRange: {...}, panBaseRange: {...}, ... }
[PAN] applyPanDelta START: { deltaX: ..., beforeRange: {...}, ... }
[PAN] renderSeries: { range: {...}, panBaseRange: {...}, ... }
[PAN] Direct rendering: { range: {...}, panOffsetPx: 0, ... }
```

### What to Look For

1. **Range values**: Are `range.from` and `range.to` changing correctly during pan?
2. **Span consistency**: Is `range.to - range.from` (span) staying constant during pan?
3. **Sudden jumps**: Does the range suddenly double or shift significantly?
4. **panBaseRange**: Is it set correctly at pan start?

### Test 2: Taskbar Icon

1. Log out and log back in (or run `killall -3 gnome-shell` for GNOME)
2. Open Quantlab
3. Check if icon appears in taskbar

---

## Next Steps Based on Test Results

### If Chart Works (Pan Cache Was the Bug):
- Re-enable pan cache
- Fix the offset calculation in `drawPanCache`
- Ensure cache range matches grid/series range expectations

### If Chart Still Broken (Bug is Elsewhere):
- Analyze the console logs
- Look for range inconsistencies
- Check if there's auto-fit or sync-to-data interference
- Investigate the elastic/overscroll logic

### If Taskbar Icon Still Missing:
- Run `xprop | grep WM_CLASS` and click on Quantlab window
- Update `StartupWMClass` to match exactly
- Check if icon file is valid: `file ~/.local/share/icons/hicolor/512x512/apps/quantlab.png`
