# LHS Drawing Toolbar - Tool Definitions

## Complete Tool Reference

This document defines every tool, its properties, default values, and categorization.

---

## Button 1: HUB 🔍

**Icon**: Magnifying glass / Search icon
**Click**: Open command palette (search field focused)
**Hold**: Open full Hub panel

### Hub Panel Layout

```
┌─────────────────────────────────────────────┐
│  🔍 Search: [________________________]      │  ← Always visible at top
├─────────────────────────────────────────────┤
│  ─ Recents ───────────────────────────────  │
│    [Tool 1] [Tool 2] [Tool 3] [Tool 4]      │
│    (auto-populated, pinnable via ★)         │
├─────────────────────────────────────────────┤
│  ─ Favorites ─────────────────────────────  │
│    [User-pinned tools grid]                 │
│    Profiles: [SMC ▾] [Harmonic ▾]           │
├─────────────────────────────────────────────┤
│  ─ Cursor ────────────────────────────────  │
│    ○ Crosshair  ○ Arrow  ○ Dot  ○ Demo      │
└─────────────────────────────────────────────┘
```

### Search Behavior
- Real-time filtering as user types
- Searches tool names and aliases
- Shows matching tools with their parent category
- Enter selects first result
- Arrow keys navigate results

### Recents
- Maximum 4 items
- Auto-updates on tool use
- Click star icon to pin (prevents removal)
- Pinned items always show first

---

## Button 2: LEVELS ─

**Icon**: Three horizontal lines (≡) or single horizontal line (─)
**Default Tool**: Horizontal Line
**Click**: Last used tool (default: Horizontal Line)
**Hold**: Open Levels panel

### Tools

| Tool ID | Name | Description | Icon |
|---------|------|-------------|------|
| `h_line` | Horizontal Line | Infinite horizontal line at price | ─ |
| `h_ray` | Horizontal Ray | Ray extending right from click point | ─→ |
| `v_line` | Vertical Line | Infinite vertical line at time | │ |
| `cross_line` | Cross Line | H + V line intersection | ┼ |
| `price_label` | Price Label | Label on price axis with optional text | ─● |

### Panel Layout

```
┌─────────────────────────────────────┐
│  ─ Levels ────────────────────────  │
│                                     │
│    [━] Horizontal Line              │
│    [→] Horizontal Ray               │
│    [│] Vertical Line                │
│    [┼] Cross Line                   │
│    [●] Price Label                  │
│                                     │
└─────────────────────────────────────┘
```

### Tool Properties

```typescript
interface HorizontalLineProps {
  price: number;
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  extendLeft: boolean;
  extendRight: boolean;
  showLabel: boolean;
  labelText?: string;
}

interface HorizontalRayProps {
  price: number;
  startTime: number;
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
}

interface VerticalLineProps {
  time: number;
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
}

interface CrossLineProps {
  price: number;
  time: number;
  color: string;
  lineWidth: number;
}

interface PriceLabelProps {
  price: number;
  text: string;
  color: string;
  backgroundColor: string;
}
```

---

## Button 3: TREND ╱

**Icon**: Diagonal line
**Default Tool**: Trend Line
**Click**: Last used tool (default: Trend Line)
**Hold**: Open Trend panel

### Tools

| Tool ID | Name | Description | Icon |
|---------|------|-------------|------|
| `trend_line` | Trend Line | Two-point diagonal line | ╱ |
| `ray` | Ray | Half-infinite line from point 1 through point 2 | ╱→ |
| `extended_line` | Extended Line | Infinite line through two points | ←╱→ |
| `info_line` | Info Line | Trend line with price/% change label | ╱📊 |
| `trend_angle` | Trend Angle | Line with angle measurement | ╱∠ |
| `arrow_line` | Arrow Line | Trend line with arrowhead | ╱➤ |

### Panel Layout

```
┌─────────────────────────────────────┐
│  ─ Trend ─────────────────────────  │
│                                     │
│    [╱] Trend Line                   │
│    [→] Ray                          │
│    [↔] Extended Line                │
│    [📊] Info Line                   │
│    [∠] Trend Angle                  │
│    [➤] Arrow Line                   │
│                                     │
└─────────────────────────────────────┘
```

### Tool Properties

```typescript
interface TrendLineProps {
  point1: { time: number; price: number };
  point2: { time: number; price: number };
  color: string;
  lineWidth: number;
  lineStyle: 'solid' | 'dashed' | 'dotted';
  extendLeft: boolean;
  extendRight: boolean;
}

interface RayProps extends TrendLineProps {
  // Ray always extends right, point1 is anchor
}

interface InfoLineProps extends TrendLineProps {
  showPriceChange: boolean;
  showPercentChange: boolean;
  showBarCount: boolean;
}

interface TrendAngleProps extends TrendLineProps {
  showAngle: boolean;
  anglePosition: 'start' | 'end' | 'middle';
}
```

---

## Button 4: STRUCTURE ⫽

**Icon**: Two parallel diagonal lines or channel icon
**Default Tool**: Parallel Channel
**Click**: Last used tool (default: Parallel Channel)
**Hold**: Open Structure panel

### Panel Layout (with Quick Access)

```
┌─────────────────────────────────────────────┐
│  ─ Quick Access ────────────────────────    │
│    [⫽] Parallel  [⋔] Pitchfork  [⟰] Swing   │
├─────────────────────────────────────────────┤
│  ─ Channels ────────────────────────────    │
│    [⫽] Parallel Channel                     │
│    [📈] Regression Trend                    │
│    [⌐] Flat Top/Bottom                      │
│    [⫽] Disjoint Channel                     │
│    [σ] Std Deviation Channel ★              │
├─────────────────────────────────────────────┤
│  ─ Pitchforks ──────────────────────────    │
│    [⋔] Andrews' Pitchfork                   │
│    [⋔] Schiff Pitchfork                     │
│    [⋔] Modified Schiff                      │
│    [⋔] Inside Pitchfork                     │
│    [⋔] Pitchfan                             │
├─────────────────────────────────────────────┤
│  ─ Market Structure ★ ──────────────────    │
│    [⟰] Swing High/Low Label                 │
│    [⚡] BOS Marker                          │
│    [↻] CHoCH Marker                         │
│    [▢] Invalidation Zone                    │
│    [💧] Liquidity Sweep Marker              │
└─────────────────────────────────────────────┘
```

### Tools

| Tool ID | Name | Category | Description |
|---------|------|----------|-------------|
| `parallel_channel` | Parallel Channel | Channels | Two parallel trend lines |
| `regression_trend` | Regression Trend | Channels | Best-fit line with deviation bands |
| `flat_top_bottom` | Flat Top/Bottom | Channels | One horizontal, one diagonal line |
| `disjoint_channel` | Disjoint Channel | Channels | Non-aligned parallel lines |
| `std_dev_channel` | Std Deviation Channel ★ | Channels | Statistical channel |
| `pitchfork` | Andrews' Pitchfork | Pitchforks | Classic 3-point pitchfork |
| `schiff_pitchfork` | Schiff Pitchfork | Pitchforks | Shifted median line |
| `modified_schiff` | Modified Schiff | Pitchforks | Averaged anchor points |
| `inside_pitchfork` | Inside Pitchfork | Pitchforks | Tighter channel variant |
| `pitchfan` | Pitchfan | Pitchforks | Pitchfork + fan combination |
| `swing_label` | Swing High/Low Label ★ | Market Structure | HH/HL/LH/LL markers |
| `bos_marker` | BOS Marker ★ | Market Structure | Break of Structure label |
| `choch_marker` | CHoCH Marker ★ | Market Structure | Change of Character label |
| `invalidation_zone` | Invalidation Zone ★ | Market Structure | Zone where thesis fails |
| `liquidity_sweep` | Liquidity Sweep ★ | Market Structure | Stop hunt annotation |

### Tool Properties

```typescript
interface ParallelChannelProps {
  point1: { time: number; price: number };
  point2: { time: number; price: number };
  point3: { time: number; price: number }; // Defines channel width
  color: string;
  fillColor: string;
  fillOpacity: number;
  lineWidth: number;
  extendLeft: boolean;
  extendRight: boolean;
}

interface PitchforkProps {
  point1: { time: number; price: number }; // Anchor
  point2: { time: number; price: number }; // Left extreme
  point3: { time: number; price: number }; // Right extreme
  color: string;
  lineWidth: number;
  showMedianLine: boolean;
  medianLevels: number[]; // e.g., [0.25, 0.5, 0.75, 1]
}

interface SwingLabelProps {
  point: { time: number; price: number };
  type: 'HH' | 'HL' | 'LH' | 'LL';
  color: string;
  showLine: boolean;
}

interface BOSMarkerProps {
  startPoint: { time: number; price: number };
  endPoint: { time: number; price: number };
  direction: 'bullish' | 'bearish';
  color: string;
  showLabel: boolean;
}
```

---

## Button 5: ZONES ▭

**Icon**: Rectangle
**Default Tool**: Rectangle
**Click**: Last used tool (default: Rectangle)
**Hold**: Open Zones panel

### Panel Layout

```
┌─────────────────────────────────────────────┐
│  ─ Basic ───────────────────────────────    │
│    [▭] Rectangle                            │
│    [◇] Rotated Rectangle                    │
├─────────────────────────────────────────────┤
│  ─ Smart Zones ★ ───────────────────────    │
│    [S/D] Supply/Demand Zone                 │
│    [OB] Order Block                         │
│    [FVG] Fair Value Gap                     │
│    [BB] Breaker Block                       │
├─────────────────────────────────────────────┤
│  ─ Session ★ ───────────────────────────    │
│    [🌏] Session Box (Asia/LON/NY)           │
│    [OR] Opening Range Box                   │
└─────────────────────────────────────────────┘
```

### Tools

| Tool ID | Name | Category | Description |
|---------|------|----------|-------------|
| `rectangle` | Rectangle | Basic | Basic rectangle |
| `rotated_rectangle` | Rotated Rectangle | Basic | Angled rectangle |
| `supply_demand_zone` | Supply/Demand Zone ★ | Smart | Intelligent S/D marking |
| `order_block` | Order Block ★ | Smart | ICT order block |
| `fair_value_gap` | Fair Value Gap ★ | Smart | FVG/imbalance box |
| `breaker_block` | Breaker Block ★ | Smart | Failed OB turned breaker |
| `session_box` | Session Box ★ | Session | Asia/London/NY range |
| `opening_range` | Opening Range ★ | Session | First X-minute range |

### Tool Properties

```typescript
interface RectangleProps {
  point1: { time: number; price: number };
  point2: { time: number; price: number };
  color: string;
  fillColor: string;
  fillOpacity: number;
  borderWidth: number;
  borderStyle: 'solid' | 'dashed' | 'dotted';
}

interface SupplyDemandZoneProps extends RectangleProps {
  zoneType: 'supply' | 'demand';
  strength: 'weak' | 'moderate' | 'strong';
  mitigated: boolean;
  showMitigatedStyle: boolean;
}

interface OrderBlockProps extends RectangleProps {
  obType: 'bullish' | 'bearish';
  mitigated: boolean;
  isBreaker: boolean;
}

interface FairValueGapProps {
  topPrice: number;
  bottomPrice: number;
  startTime: number;
  endTime: number;
  gapType: 'bullish' | 'bearish';
  partiallyFilled: boolean;
  fillPercentage: number;
}

interface SessionBoxProps {
  session: 'asia' | 'london' | 'newyork' | 'custom';
  customStartTime?: string; // "HH:MM"
  customEndTime?: string;
  showHighLow: boolean;
  extendLines: boolean;
}
```

---

## Button 6: OVERLAYS ϕ

**Icon**: Fibonacci symbol (ϕ) or golden ratio icon
**Default Tool**: Fib Retracement
**Click**: Last used tool (default: Fib Retracement)
**Hold**: Open Overlays panel (tabbed)

### Panel Layout (Tabbed)

```
┌─────────────────────────────────────────────┐
│  [ Fib / Gann ]  [ Volume ]   ← Tab bar     │
├─────────────────────────────────────────────┤
│                                             │
│  ═══ TAB 1: Fib / Gann ═══                  │
│                                             │
│  ─ Fibonacci Core ─                         │
│    [ϕ] Fib Retracement                      │
│    [ϕ→] Trend-Based Extension               │
│    [ϕ⫽] Fib Channel                         │
│    [⚡ϕ] Auto-Fib ★                          │
│    [OTE] OTE Zone ★                         │
│                                             │
│  ─ Fibonacci Time ─                         │
│    [ϕ│] Fib Time Zone                       │
│    [ϕ│→] Trend-Based Fib Time               │
│                                             │
│  ─ Fibonacci Advanced ─                     │
│    [ϕ/] Speed Resistance Fan                │
│    [ϕ(] Speed Resistance Arcs               │
│    [ϕ○] Fib Circles                         │
│    [ϕ@] Fib Spiral                          │
│    [ϕ◁] Fib Wedge                           │
│                                             │
│  ─ Gann ─                                   │
│    [G/] Gann Fan                            │
│    [G▭] Gann Box                            │
│    [G□] Gann Square                         │
│                                             │
│  ═══ TAB 2: Volume ═══                      │
│                                             │
│  ─ VWAP ─                                   │
│    [V] Anchored VWAP                        │
│    [Vσ] VWAP Bands ★                        │
│    [VS] Session VWAP ★                      │
│                                             │
│  ─ Volume Profile ─                         │
│    [VP] Fixed Range Volume Profile          │
│    [VP⚓] Anchored Volume Profile            │
│    [POC] POC Projection ★                   │
│    [VA] Value Area Highlight ★              │
│                                             │
└─────────────────────────────────────────────┘
```

### Fibonacci Tools

| Tool ID | Name | Description |
|---------|------|-------------|
| `fib_retracement` | Fib Retracement | Classic retracement levels |
| `fib_extension` | Trend-Based Extension | 3-point extension levels |
| `fib_channel` | Fib Channel | Parallel fib-spaced lines |
| `auto_fib` | Auto-Fib ★ | One-click swing detection |
| `ote_zone` | OTE Zone ★ | 62-79% highlighted zone |
| `fib_time_zone` | Fib Time Zone | Vertical time intervals |
| `fib_time_trend` | Trend-Based Fib Time | 3-point time projection |
| `fib_fan` | Speed Resistance Fan | Angled fib lines |
| `fib_arcs` | Speed Resistance Arcs | Curved fib lines |
| `fib_circles` | Fib Circles | Concentric fib circles |
| `fib_spiral` | Fib Spiral | Logarithmic spiral |
| `fib_wedge` | Fib Wedge | Converging fib lines |
| `gann_fan` | Gann Fan | Angle-based lines |
| `gann_box` | Gann Box | Price/time grid |
| `gann_square` | Gann Square | Square of 9 overlay |

### Volume Tools

| Tool ID | Name | Description |
|---------|------|-------------|
| `anchored_vwap` | Anchored VWAP | VWAP from selected point |
| `vwap_bands` | VWAP Bands ★ | VWAP with std dev bands |
| `session_vwap` | Session VWAP ★ | Session-anchored VWAP |
| `fixed_range_vp` | Fixed Range VP | VP for selected range |
| `anchored_vp` | Anchored VP | VP from anchor to present |
| `poc_projection` | POC Projection ★ | Extend POC as S/R |
| `value_area` | Value Area ★ | VA High/Low highlight |

### Tool Properties

```typescript
interface FibRetracementProps {
  point1: { time: number; price: number };
  point2: { time: number; price: number };
  levels: number[]; // Default: [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1]
  extendLeft: boolean;
  extendRight: boolean;
  showLabels: boolean;
  showPrices: boolean;
  colors: { [level: number]: string };
}

interface FibExtensionProps {
  point1: { time: number; price: number };
  point2: { time: number; price: number };
  point3: { time: number; price: number };
  levels: number[]; // Default: [0, 0.618, 1, 1.618, 2, 2.618]
}

interface AnchoredVWAPProps {
  anchorTime: number;
  color: string;
  lineWidth: number;
  showBands: boolean;
  bandMultipliers: number[]; // e.g., [1, 2, 3] for 1σ, 2σ, 3σ
}

interface VolumeProfileProps {
  startTime: number;
  endTime: number;
  rowCount: number;
  showPOC: boolean;
  showValueArea: boolean;
  valueAreaPercent: number; // Default: 70
  pocColor: string;
  vaColor: string;
}
```

---

## Button 7: PATTERNS ◇

**Icon**: Diamond or pattern symbol
**Default Tool**: Triangle
**Click**: Last used tool (default: Triangle)
**Hold**: Open Patterns panel

### Panel Layout (with Quick Access)

```
┌─────────────────────────────────────────────┐
│  ─ Quick Access ────────────────────────    │
│    [△] Triangle  [◇] XABCD  [12345] Impulse │
├─────────────────────────────────────────────┤
│  ─ Harmonic ────────────────────────────    │
│    [◇] XABCD Pattern                        │
│    [◇] ABCD Pattern                         │
│    [◇] Cypher Pattern                       │
│    [◇] Three Drives                         │
├─────────────────────────────────────────────┤
│  ─ Chart Patterns ──────────────────────    │
│    [△] Triangle                             │
│    [M] Head & Shoulders                     │
│    [◁] Wedge Template ★                     │
│    [W] Double Top/Bottom ★                  │
├─────────────────────────────────────────────┤
│  ─ Elliott Wave ────────────────────────    │
│    [12345] Impulse                          │
│    [ABC] Correction                         │
│    [ABCDE] Triangle                         │
│    [WXY] Double Combo                       │
│    [WXYXZ] Triple Combo                     │
├─────────────────────────────────────────────┤
│  ─ Cycles ──────────────────────────────    │
│    [|||] Cyclic Lines                       │
│    [~] Time Cycles                          │
│    [∿] Sine Line                            │
└─────────────────────────────────────────────┘
```

### Tools

| Tool ID | Name | Category |
|---------|------|----------|
| `xabcd_pattern` | XABCD Pattern | Harmonic |
| `abcd_pattern` | ABCD Pattern | Harmonic |
| `cypher_pattern` | Cypher Pattern | Harmonic |
| `three_drives` | Three Drives | Harmonic |
| `triangle_pattern` | Triangle | Chart |
| `head_shoulders` | Head & Shoulders | Chart |
| `wedge_template` | Wedge Template ★ | Chart |
| `double_top_bottom` | Double Top/Bottom ★ | Chart |
| `elliott_impulse` | Impulse (12345) | Elliott |
| `elliott_correction` | Correction (ABC) | Elliott |
| `elliott_triangle` | Triangle (ABCDE) | Elliott |
| `elliott_double` | Double Combo (WXY) | Elliott |
| `elliott_triple` | Triple Combo (WXYXZ) | Elliott |
| `cyclic_lines` | Cyclic Lines | Cycles |
| `time_cycles` | Time Cycles | Cycles |
| `sine_line` | Sine Line | Cycles |

---

## Button 8: PLAN ◎

**Icon**: Target or crosshair
**Default Tool**: Long Position
**Click**: Last used tool (default: Long Position)
**Hold**: Open Plan panel

### Panel Layout

```
┌─────────────────────────────────────────────┐
│  ─ Position Tools ──────────────────────    │
│    [📈] Long Position                       │
│    [📉] Short Position                      │
│    [🎯] Multi-Target Position ★             │
│    [📊] Scaled Entry Position ★             │
├─────────────────────────────────────────────┤
│  ─ Forecast ────────────────────────────    │
│    [→] Forecast Arrow                       │
│    [↗] Projection                           │
│    [📋] Bars Pattern                        │
│    [👻] Ghost Feed                          │
└─────────────────────────────────────────────┘
```

### Tools

| Tool ID | Name | Description |
|---------|------|-------------|
| `long_position` | Long Position | Entry + stop + target |
| `short_position` | Short Position | Entry + stop + target |
| `multi_target` | Multi-Target ★ | T1/T2/T3 with R:R |
| `scaled_entry` | Scaled Entry ★ | Multiple entries |
| `forecast` | Forecast Arrow | Projected move |
| `projection` | Projection | Extended measured move |
| `bars_pattern` | Bars Pattern | Clone historical bars |
| `ghost_feed` | Ghost Feed | Draw future candles |

### Tool Properties

```typescript
interface PositionToolProps {
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  positionSize?: number;
  riskPercent?: number;
  showRR: boolean; // Risk:Reward ratio
  showPL: boolean; // Profit/Loss in currency
}

interface MultiTargetProps extends PositionToolProps {
  targets: Array<{
    price: number;
    percentage: number; // % of position to close
  }>;
}

interface ForecastProps {
  startPoint: { time: number; price: number };
  endPoint: { time: number; price: number };
  direction: 'up' | 'down';
  showPercent: boolean;
  showPrice: boolean;
}
```

---

## Button 9: MEASURE 📏

**Icon**: Ruler
**Default Tool**: Quick Measure
**Click**: Quick Measure (temporary measurement)
**Hold**: Open Measure panel

### Panel Layout

```
┌─────────────────────────────────────────────┐
│  ─ Measure ─────────────────────────────    │
│    [📏] Quick Measure (temporary)           │
│    [↔] Price Range (permanent)              │
│    [⟷] Date Range (permanent)               │
│    [↕↔] Price + Date Range                  │
│    [🔍] Box Zoom                            │
└─────────────────────────────────────────────┘
```

### Tools

| Tool ID | Name | Description |
|---------|------|-------------|
| `quick_measure` | Quick Measure | Temporary measure overlay |
| `price_range` | Price Range | Permanent price measurement |
| `date_range` | Date Range | Permanent time measurement |
| `combined_range` | Price + Date Range | Both dimensions |
| `box_zoom` | Box Zoom | Zoom to selection |

---

## Button 10: ANNOTATE T

**Icon**: Letter T or text icon
**Default Tool**: Text
**Click**: Last used tool (default: Text)
**Hold**: Open Annotate panel

### Panel Layout

```
┌─────────────────────────────────────────────┐
│  ─ Text ────────────────────────────────    │
│    [T] Text                                 │
│    [T⚓] Anchored Text                       │
│    [💬] Callout                             │
│    [📝] Note / Anchored Note                │
│    [💭] Comment                             │
├─────────────────────────────────────────────┤
│  ─ Labels ──────────────────────────────    │
│    [🚩] Signpost                            │
│    [⚑] Flag Mark                            │
│    [📍] Pin                                 │
├─────────────────────────────────────────────┤
│  ─ Shapes ──────────────────────────────    │
│    [○] Circle / Ellipse / Triangle          │
│    [⌒] Arc / Curve / Double Curve           │
│    [⟋] Path / Polyline                      │
│    [🖌] Brush / Highlighter                 │
├─────────────────────────────────────────────┤
│  ─ Markers ─────────────────────────────    │
│    [↑↓] Arrow Markers                       │
│    [★] Icons                                │
│    [😊] Emojis                              │
│    [🎨] Stickers                            │
├─────────────────────────────────────────────┤
│  ─ Embed ───────────────────────────────    │
│    [🖼] Image                               │
│    [📊] Table / Price Table                 │
│    [🐦] Tweet / Idea                        │
│    [📓] Trade Journal Entry ★               │
└─────────────────────────────────────────────┘
```

### Tools

| Tool ID | Name | Category |
|---------|------|----------|
| `text` | Text | Text |
| `anchored_text` | Anchored Text | Text |
| `callout` | Callout | Text |
| `note` | Note | Text |
| `anchored_note` | Anchored Note | Text |
| `comment` | Comment | Text |
| `signpost` | Signpost | Labels |
| `flag_mark` | Flag Mark | Labels |
| `pin` | Pin | Labels |
| `circle` | Circle | Shapes |
| `ellipse` | Ellipse | Shapes |
| `triangle_shape` | Triangle Shape | Shapes |
| `arc` | Arc | Shapes |
| `curve` | Curve | Shapes |
| `double_curve` | Double Curve | Shapes |
| `path` | Path | Shapes |
| `polyline` | Polyline | Shapes |
| `brush` | Brush | Shapes |
| `highlighter` | Highlighter | Shapes |
| `arrow_marker_up` | Arrow Up | Markers |
| `arrow_marker_down` | Arrow Down | Markers |
| `arrow_marker_left` | Arrow Left | Markers |
| `arrow_marker_right` | Arrow Right | Markers |
| `icon` | Icon | Markers |
| `emoji` | Emoji | Markers |
| `sticker` | Sticker | Markers |
| `image` | Image | Embed |
| `table` | Table | Embed |
| `price_table` | Price Table | Embed |
| `tweet` | Tweet | Embed |
| `idea` | Idea | Embed |
| `journal_entry` | Trade Journal Entry ★ | Embed |

---

## Control Dock

### Snap (🧲)

**Click**: Toggle snap on/off
**Hold**: Snap settings menu

```
┌─────────────────────────────────────────────┐
│  ─ Snap Mode ───────────────────────────    │
│    ○ Off                                    │
│    ○ Weak                                   │
│    ● Strong                                 │
├─────────────────────────────────────────────┤
│  ─ Snap To ─────────────────────────────    │
│    ☑ Wicks (High/Low)                       │
│    ☑ Body (Open/Close)                      │
│    ☐ Close Only                             │
│    ☐ Indicators                             │
│    ☐ Other Drawings                         │
└─────────────────────────────────────────────┘
```

### Lock (🔒)

**Click**: Toggle lock all drawings
**Hold**: Lock options

```
┌─────────────────────────────────────────────┐
│    [🔒] Lock All                            │
│    [🔓] Unlock All                          │
│    [🔒] Lock Selected                       │
│    ─────────────────────────                │
│    ☐ Lock After Create                      │
└─────────────────────────────────────────────┘
```

### Visibility (👁)

**Click**: Toggle all drawings visibility
**Hold**: Visibility options

```
┌─────────────────────────────────────────────┐
│    ☑ Drawings                               │
│    ☑ Indicators                             │
│    ☑ Positions/Orders                       │
│    ─────────────────────────                │
│    [👁] Show All                            │
│    [👁] Hide All                            │
└─────────────────────────────────────────────┘
```

### Delete (🗑)

**Click**: Toggle eraser mode
**Hold**: Delete options

```
┌─────────────────────────────────────────────┐
│    [✕] Delete Selected                      │
│    [🗑] Remove All Drawings                 │
│    [🗑] Remove Indicators                   │
│    [🗑] Remove All                          │
└─────────────────────────────────────────────┘
```

### More (···)

**Click**: Open more options panel

```
┌─────────────────────────────────────────────┐
│    ☐ Stay in Drawing Mode                   │
│    ─────────────────────────                │
│    ─ Sync ──────────────────                │
│    ○ Off                                    │
│    ○ Within Layout                          │
│    ○ Global                                 │
│    ─────────────────────────                │
│    [🗂] Object Tree                         │
│    [⚙] Toolbar Settings                     │
└─────────────────────────────────────────────┘
```

---

## New Tools Summary (★)

| Tool | Location | Purpose |
|------|----------|---------|
| Std Deviation Channel | Structure → Channels | Statistical channel |
| Swing High/Low Label | Structure → Market Structure | HH/HL/LH/LL |
| BOS Marker | Structure → Market Structure | Break of structure |
| CHoCH Marker | Structure → Market Structure | Change of character |
| Invalidation Zone | Structure → Market Structure | Thesis failure zone |
| Liquidity Sweep | Structure → Market Structure | Stop hunt annotation |
| Supply/Demand Zone | Zones → Smart | S/D marking |
| Order Block | Zones → Smart | ICT order block |
| Fair Value Gap | Zones → Smart | FVG/imbalance |
| Breaker Block | Zones → Smart | Failed OB |
| Session Box | Zones → Session | Asia/LON/NY range |
| Opening Range | Zones → Session | First X-min range |
| Auto-Fib | Overlays → Fib | One-click swing fib |
| OTE Zone | Overlays → Fib | 62-79% highlight |
| VWAP Bands | Overlays → Volume | Deviation bands |
| Session VWAP | Overlays → Volume | Session-anchored |
| POC Projection | Overlays → Volume | Extend POC |
| Value Area | Overlays → Volume | VA highlight |
| Wedge Template | Patterns → Chart | Quick wedge |
| Double Top/Bottom | Patterns → Chart | Reversal template |
| Multi-Target Position | Plan → Position | T1/T2/T3 |
| Scaled Entry | Plan → Position | Averaging entries |
| Trade Journal Entry | Annotate → Embed | Trade logging |
