# Drawing Tools Architecture (V3 Add-On)
**Purpose:** Define the complete architecture for drawing tools—trend lines, Fibonacci, shapes, annotations—including object model, interaction, persistence, and rendering.

This document covers:
- drawing object model and type system
- hit testing and handle interaction
- edit state machine
- undo/redo integration
- persistence and serialization
- rendering pipeline integration

> Design goal: **Drawing interactions feel native.** Handle dragging, snapping, and multi-select must be smooth and predictable.

---

## 0) Core requirements

1. Support **30+ drawing tool types** (lines, shapes, Fibonacci, Gann, etc.)
2. **Precise hit testing**: handles selectable even on dense charts
3. **Smooth handle dragging**: no lag during anchor point manipulation
4. **Magnetic snapping**: to price levels, bar timestamps, other drawings
5. **Persistence**: drawings survive page refresh and sync across devices
6. **Undo/redo**: full history with Ctrl+Z / Ctrl+Shift+Z

---

## 1) Drawing type taxonomy

### 1.1 Base categories

| Category | Examples | Characteristics |
|---|---|---|
| **Lines** | Trend line, Horizontal, Vertical, Ray, Extended | 2 anchor points, infinite extension options |
| **Channels** | Parallel channel, Regression channel | 3+ points, parallel constraints |
| **Fibonacci** | Retracement, Extension, Fan, Arcs, Time zones | 2-3 anchors, computed levels |
| **Gann** | Gann fan, Gann box, Gann square | Angle-based projections |
| **Shapes** | Rectangle, Ellipse, Triangle, Arc | Bounding box or multi-point |
| **Annotations** | Text, Callout, Price label, Arrow | Text content + position |
| **Measurements** | Price range, Date range, Bars pattern | Two points, display computed values |
| **Brushes** | Freehand, Highlighter | Path of many points |

### 1.2 MVP drawing set (15 tools)

| ID | Name | Category | Anchors | Properties |
|---|---|---|---|---|
| `trend_line` | Trend Line | Lines | 2 | extend_left, extend_right |
| `horizontal_line` | Horizontal Line | Lines | 1 | price level |
| `vertical_line` | Vertical Line | Lines | 1 | timestamp |
| `ray` | Ray | Lines | 2 | extend_right only |
| `extended_line` | Extended Line | Lines | 2 | extend both |
| `parallel_channel` | Parallel Channel | Channels | 3 | fill_color, fill_opacity |
| `fib_retracement` | Fibonacci Retracement | Fibonacci | 2 | levels[], show_prices |
| `fib_extension` | Fibonacci Extension | Fibonacci | 3 | levels[], show_prices |
| `rectangle` | Rectangle | Shapes | 2 | fill_color, fill_opacity |
| `ellipse` | Ellipse | Shapes | 2 | fill_color, fill_opacity |
| `text` | Text | Annotations | 1 | content, font_size |
| `arrow` | Arrow | Annotations | 2 | arrow_style |
| `price_range` | Price Range | Measurements | 2 | show_percentage |
| `date_range` | Date Range | Measurements | 2 | show_bars_count |
| `brush` | Brush | Brushes | N | stroke_width |

---

## 2) Drawing object model

### 2.1 Base drawing interface
```typescript
interface Drawing {
  // Identity
  id: string;                    // UUID
  type: DrawingType;             // "trend_line", "fib_retracement", etc.
  
  // Ownership
  paneId: string;                // Which pane this drawing belongs to
  seriesId?: string;             // Optional: linked to specific series
  
  // Anchor points (in data coordinates)
  anchors: AnchorPoint[];
  
  // Visual properties
  style: DrawingStyle;
  
  // State
  visible: boolean;
  locked: boolean;               // Prevent editing
  
  // Metadata
  createdAt: number;
  modifiedAt: number;
  revision: number;              // For sync/conflict resolution
}

interface AnchorPoint {
  // Data coordinates (survive pan/zoom)
  time: number;                  // Unix timestamp ms
  price: number;                 // Price value
  
  // Optional: bar index for snapped anchors
  barIndex?: number;
}

interface DrawingStyle {
  // Stroke
  strokeColor: string;           // Hex color
  strokeWidth: number;           // CSS pixels
  strokeStyle: "solid" | "dashed" | "dotted";
  
  // Fill (for shapes)
  fillColor?: string;
  fillOpacity?: number;          // 0-1
  
  // Text (for annotations)
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;
  
  // Type-specific
  [key: string]: any;
}
```

### 2.2 Type-specific extensions
```typescript
interface TrendLineDrawing extends Drawing {
  type: "trend_line";
  extendLeft: boolean;
  extendRight: boolean;
}

interface FibRetracementDrawing extends Drawing {
  type: "fib_retracement";
  levels: FibLevel[];
  showPrices: boolean;
  showPercentages: boolean;
  reverseDirection: boolean;
}

interface FibLevel {
  ratio: number;                 // 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0
  color: string;
  visible: boolean;
  lineStyle: "solid" | "dashed";
}

interface TextDrawing extends Drawing {
  type: "text";
  content: string;
  backgroundColor?: string;
  borderColor?: string;
  padding: number;
}

interface BrushDrawing extends Drawing {
  type: "brush";
  // Path stored as compressed delta-encoded points
  pathData: ArrayBuffer;         // Compressed path
  smoothing: number;             // 0-1
}
```

### 2.3 Drawing registry
```typescript
interface DrawingTypeDefinition {
  type: DrawingType;
  name: string;
  icon: string;                  // Icon identifier
  category: DrawingCategory;
  
  // Anchor configuration
  minAnchors: number;
  maxAnchors: number;
  anchorLabels?: string[];       // ["Start", "End"] for lines
  
  // Default style
  defaultStyle: Partial<DrawingStyle>;
  
  // Behavior
  allowExtend?: boolean;
  allowFill?: boolean;
  hasComputedLevels?: boolean;   // Fibonacci, etc.
  
  // Rendering
  render: (drawing: Drawing, ctx: DrawingRenderContext) => void;
  
  // Hit testing
  hitTest: (drawing: Drawing, point: Point, tolerance: number) => HitTestResult | null;
  
  // Computed geometry
  getHandles: (drawing: Drawing) => Handle[];
  getPath?: (drawing: Drawing) => Path2D;
}
```

---

## 3) Coordinate systems

### 3.1 Three coordinate spaces
```
DATA SPACE          →    SCREEN SPACE       →    PHYSICAL PIXELS
(time, price)            (CSS pixels)            (device pixels)

Anchor storage          Hit testing              Rendering
Price comparisons       UI calculations          GPU coordinates
Persistence             Tooltip positioning      Snapping
```

### 3.2 Coordinate transforms
```typescript
interface CoordinateTransform {
  // Data → Screen
  timeToX(time: number): number;
  priceToY(price: number): number;
  dataToScreen(anchor: AnchorPoint): Point;
  
  // Screen → Data
  xToTime(x: number): number;
  yToPrice(y: number): number;
  screenToData(point: Point): AnchorPoint;
  
  // Screen → Physical
  screenToPhysical(point: Point): Point;
  physicalToScreen(point: Point): Point;
  
  // Current scale info
  timeScale: { min: number; max: number; pixelsPerMs: number };
  priceScale: { min: number; max: number; pixelsPerUnit: number };
}
```

### 3.3 Anchor resolution
When loading drawings, resolve data coordinates to current viewport:
```typescript
function resolveAnchor(anchor: AnchorPoint, series: SeriesData): ResolvedAnchor {
  // If bar index is stored and valid, use it for exact positioning
  if (anchor.barIndex !== undefined && anchor.barIndex < series.length) {
    return {
      time: series.time[anchor.barIndex],
      price: anchor.price,
      barIndex: anchor.barIndex,
    };
  }
  
  // Otherwise, find nearest bar by timestamp
  const barIndex = findNearestBarIndex(series.time, anchor.time);
  return {
    time: anchor.time,
    price: anchor.price,
    barIndex,
  };
}
```

---

## 4) Hit testing architecture

### 4.1 No-GPU-readback rule
Hit testing must be CPU-only for hover. GPU picking is click-only (see V3 spec doc 07).

### 4.2 Spatial indexing
```typescript
class DrawingSpatialIndex {
  private grid: Map<string, Set<string>>;  // gridKey → Set<drawingId>
  private cellSize: number = 50;           // CSS pixels
  
  // Index a drawing's bounding box
  index(drawing: Drawing, screenBounds: Rect): void {
    const cells = this.getCellsForRect(screenBounds);
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`;
      if (!this.grid.has(key)) this.grid.set(key, new Set());
      this.grid.get(key)!.add(drawing.id);
    }
  }
  
  // Query drawings near a point
  query(point: Point, radius: number): string[] {
    const cells = this.getCellsForRect({
      x: point.x - radius,
      y: point.y - radius,
      width: radius * 2,
      height: radius * 2,
    });
    
    const candidates = new Set<string>();
    for (const cell of cells) {
      const key = `${cell.x},${cell.y}`;
      const ids = this.grid.get(key);
      if (ids) ids.forEach(id => candidates.add(id));
    }
    return Array.from(candidates);
  }
  
  // Rebuild on viewport change
  rebuild(drawings: Drawing[], transform: CoordinateTransform): void {
    this.grid.clear();
    for (const drawing of drawings) {
      const bounds = computeScreenBounds(drawing, transform);
      this.index(drawing, bounds);
    }
  }
}
```

### 4.3 Per-drawing hit test functions
```typescript
// Line hit test: distance to line segment
function hitTestLine(
  p1: Point, p2: Point, 
  testPoint: Point, 
  tolerance: number
): { hit: boolean; distance: number; t: number } {
  const dx = p2.x - p1.x;
  const dy = p2.y - p1.y;
  const lenSq = dx * dx + dy * dy;
  
  if (lenSq === 0) {
    const dist = distance(p1, testPoint);
    return { hit: dist <= tolerance, distance: dist, t: 0 };
  }
  
  // Parameter t along line segment [0, 1]
  let t = ((testPoint.x - p1.x) * dx + (testPoint.y - p1.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  
  const closest = { x: p1.x + t * dx, y: p1.y + t * dy };
  const dist = distance(closest, testPoint);
  
  return { hit: dist <= tolerance, distance: dist, t };
}

// Rectangle hit test: point in rect or near edge
function hitTestRectangle(
  rect: Rect,
  testPoint: Point,
  tolerance: number
): HitTestResult | null {
  // Check if inside
  if (pointInRect(testPoint, rect)) {
    return { type: "body", distance: 0 };
  }
  
  // Check edges
  const edges = getRectEdges(rect);
  for (const [i, edge] of edges.entries()) {
    const result = hitTestLine(edge.p1, edge.p2, testPoint, tolerance);
    if (result.hit) {
      return { type: "edge", edgeIndex: i, distance: result.distance };
    }
  }
  
  return null;
}
```

### 4.4 Handle hit testing
```typescript
interface Handle {
  id: string;                    // "anchor-0", "midpoint", "rotation", etc.
  type: "anchor" | "midpoint" | "control" | "rotation";
  position: Point;               // Screen coordinates
  cursor: string;                // CSS cursor style
}

function hitTestHandles(
  handles: Handle[],
  testPoint: Point,
  tolerance: number = 8
): Handle | null {
  // Handles have priority over drawing body
  for (const handle of handles) {
    const dist = distance(handle.position, testPoint);
    if (dist <= tolerance) {
      return handle;
    }
  }
  return null;
}
```

---

## 5) Interaction state machine

### 5.1 States
```typescript
type DrawingInteractionState =
  | { type: "idle" }
  | { type: "hovering"; drawingId: string; part: HitPart }
  | { type: "creating"; toolType: DrawingType; anchors: AnchorPoint[]; preview: Drawing }
  | { type: "selected"; drawingIds: string[] }
  | { type: "dragging_handle"; drawingId: string; handleId: string; startPoint: Point }
  | { type: "dragging_drawing"; drawingIds: string[]; startPoint: Point }
  | { type: "box_selecting"; startPoint: Point; currentPoint: Point }
  | { type: "context_menu"; drawingId: string; position: Point };
```

### 5.2 State transitions
```
                                    ┌──────────────┐
                            ┌──────►│   IDLE       │◄──────┐
                            │       └──────┬───────┘       │
                            │              │               │
                      ESC / │         hover│          click│empty
                     click  │              ▼               │
                     empty  │       ┌──────────────┐       │
                            │       │  HOVERING    │───────┤
                            │       └──────┬───────┘       │
                            │              │               │
                            │         click│               │
                            │              ▼               │
                            │       ┌──────────────┐       │
                            ├───────│  SELECTED    │◄──────┤
                            │       └──────┬───────┘       │
                            │              │               │
                            │    drag start│on handle      │
                            │              ▼               │
                            │       ┌──────────────┐       │
                            │       │DRAGGING_HANDLE│──────┤
                            │       └──────────────┘  drop │
                            │                              │
                      tool  │                              │
                    select  │       ┌──────────────┐       │
                            └───────│  CREATING    │───────┘
                                    └──────────────┘  complete
```

### 5.3 State machine implementation
```typescript
class DrawingInteractionEngine {
  private state: DrawingInteractionState = { type: "idle" };
  private drawings: DrawingStore;
  private spatialIndex: DrawingSpatialIndex;
  private transform: CoordinateTransform;
  
  handlePointerMove(event: PointerEvent): void {
    const screenPoint = { x: event.clientX, y: event.clientY };
    
    switch (this.state.type) {
      case "idle":
      case "hovering":
        this.updateHover(screenPoint);
        break;
        
      case "creating":
        this.updateCreationPreview(screenPoint);
        break;
        
      case "dragging_handle":
        this.updateHandleDrag(screenPoint);
        break;
        
      case "dragging_drawing":
        this.updateDrawingDrag(screenPoint);
        break;
        
      case "box_selecting":
        this.updateBoxSelection(screenPoint);
        break;
    }
  }
  
  handlePointerDown(event: PointerEvent): void {
    const screenPoint = { x: event.clientX, y: event.clientY };
    
    switch (this.state.type) {
      case "idle":
      case "hovering":
        this.handleClick(screenPoint, event);
        break;
        
      case "selected":
        this.handleClickWhileSelected(screenPoint, event);
        break;
        
      case "creating":
        this.handleClickWhileCreating(screenPoint);
        break;
    }
  }
  
  handlePointerUp(event: PointerEvent): void {
    switch (this.state.type) {
      case "dragging_handle":
        this.completeHandleDrag();
        break;
        
      case "dragging_drawing":
        this.completeDrawingDrag();
        break;
        
      case "box_selecting":
        this.completeBoxSelection();
        break;
    }
  }
  
  handleKeyDown(event: KeyboardEvent): void {
    if (event.key === "Escape") {
      this.cancelCurrentAction();
    } else if (event.key === "Delete" || event.key === "Backspace") {
      this.deleteSelected();
    } else if (event.key === "z" && (event.ctrlKey || event.metaKey)) {
      if (event.shiftKey) {
        this.redo();
      } else {
        this.undo();
      }
    }
  }
}
```

---

## 6) Snapping system

### 6.1 Snap targets
```typescript
type SnapTarget =
  | { type: "bar"; barIndex: number; time: number }
  | { type: "price"; price: number; source: "round" | "ohlc" | "indicator" | "drawing" }
  | { type: "drawing_anchor"; drawingId: string; anchorIndex: number }
  | { type: "grid"; x?: number; y?: number };

interface SnapResult {
  snapped: boolean;
  target?: SnapTarget;
  point: AnchorPoint;
}
```

### 6.2 Snap configuration
```typescript
interface SnapConfig {
  enabled: boolean;
  
  // Snap to bar timestamps
  snapToBar: boolean;
  barSnapRadius: number;         // CSS pixels
  
  // Snap to price levels
  snapToPrice: boolean;
  priceSnapRadius: number;
  snapToRoundNumbers: boolean;   // $100, $50, $10, etc.
  snapToOHLC: boolean;           // Open, High, Low, Close
  snapToIndicatorLevels: boolean;
  
  // Snap to other drawings
  snapToDrawings: boolean;
  drawingSnapRadius: number;
  
  // Angle snapping (for lines)
  snapToAngles: boolean;
  angleSnapDegrees: number[];    // [0, 45, 90, 135, 180]
}
```

### 6.3 Snap algorithm
```typescript
function computeSnap(
  rawPoint: Point,
  config: SnapConfig,
  context: SnapContext
): SnapResult {
  if (!config.enabled) {
    return { snapped: false, point: context.transform.screenToData(rawPoint) };
  }
  
  const candidates: Array<{ target: SnapTarget; distance: number; point: AnchorPoint }> = [];
  
  // Bar snapping
  if (config.snapToBar) {
    const barSnap = findNearestBar(rawPoint, context, config.barSnapRadius);
    if (barSnap) candidates.push(barSnap);
  }
  
  // Price snapping
  if (config.snapToPrice) {
    const priceSnap = findNearestPriceLevel(rawPoint, context, config);
    if (priceSnap) candidates.push(priceSnap);
  }
  
  // Drawing anchor snapping
  if (config.snapToDrawings) {
    const drawingSnap = findNearestDrawingAnchor(rawPoint, context, config.drawingSnapRadius);
    if (drawingSnap) candidates.push(drawingSnap);
  }
  
  // Select best snap (closest)
  if (candidates.length > 0) {
    candidates.sort((a, b) => a.distance - b.distance);
    const best = candidates[0];
    return { snapped: true, target: best.target, point: best.point };
  }
  
  return { snapped: false, point: context.transform.screenToData(rawPoint) };
}
```

---

## 7) Undo/redo system

### 7.1 Command pattern
```typescript
interface DrawingCommand {
  type: string;
  execute(): void;
  undo(): void;
  
  // For command merging (e.g., continuous dragging)
  canMergeWith?(other: DrawingCommand): boolean;
  mergeWith?(other: DrawingCommand): DrawingCommand;
}

class CreateDrawingCommand implements DrawingCommand {
  type = "create_drawing";
  constructor(private store: DrawingStore, private drawing: Drawing) {}
  
  execute(): void {
    this.store.add(this.drawing);
  }
  
  undo(): void {
    this.store.remove(this.drawing.id);
  }
}

class MoveAnchorCommand implements DrawingCommand {
  type = "move_anchor";
  constructor(
    private store: DrawingStore,
    private drawingId: string,
    private anchorIndex: number,
    private oldPosition: AnchorPoint,
    private newPosition: AnchorPoint
  ) {}
  
  execute(): void {
    const drawing = this.store.get(this.drawingId);
    if (drawing) {
      drawing.anchors[this.anchorIndex] = this.newPosition;
      drawing.modifiedAt = Date.now();
      drawing.revision++;
      this.store.update(drawing);
    }
  }
  
  undo(): void {
    const drawing = this.store.get(this.drawingId);
    if (drawing) {
      drawing.anchors[this.anchorIndex] = this.oldPosition;
      drawing.modifiedAt = Date.now();
      drawing.revision++;
      this.store.update(drawing);
    }
  }
  
  canMergeWith(other: DrawingCommand): boolean {
    return other instanceof MoveAnchorCommand &&
           other.drawingId === this.drawingId &&
           other.anchorIndex === this.anchorIndex;
  }
  
  mergeWith(other: MoveAnchorCommand): DrawingCommand {
    return new MoveAnchorCommand(
      this.store,
      this.drawingId,
      this.anchorIndex,
      this.oldPosition,  // Keep original old position
      other.newPosition  // Use latest new position
    );
  }
}
```

### 7.2 History manager
```typescript
class DrawingHistoryManager {
  private undoStack: DrawingCommand[] = [];
  private redoStack: DrawingCommand[] = [];
  private maxHistory: number = 100;
  
  execute(command: DrawingCommand): void {
    // Try to merge with last command
    if (this.undoStack.length > 0) {
      const last = this.undoStack[this.undoStack.length - 1];
      if (last.canMergeWith?.(command)) {
        this.undoStack[this.undoStack.length - 1] = last.mergeWith!(command);
        command.execute();
        return;
      }
    }
    
    command.execute();
    this.undoStack.push(command);
    this.redoStack = [];  // Clear redo on new action
    
    // Enforce max history
    while (this.undoStack.length > this.maxHistory) {
      this.undoStack.shift();
    }
  }
  
  undo(): boolean {
    const command = this.undoStack.pop();
    if (!command) return false;
    
    command.undo();
    this.redoStack.push(command);
    return true;
  }
  
  redo(): boolean {
    const command = this.redoStack.pop();
    if (!command) return false;
    
    command.execute();
    this.undoStack.push(command);
    return true;
  }
}
```

---

## 8) Persistence and serialization

### 8.1 Storage format (JSON)
```typescript
interface DrawingStorage {
  version: number;               // Schema version for migration
  drawings: SerializedDrawing[];
}

interface SerializedDrawing {
  id: string;
  type: DrawingType;
  paneId: string;
  seriesId?: string;
  anchors: SerializedAnchor[];
  style: DrawingStyle;
  visible: boolean;
  locked: boolean;
  createdAt: number;
  modifiedAt: number;
  revision: number;
  
  // Type-specific data
  data?: Record<string, any>;
}

interface SerializedAnchor {
  time: number;
  price: number;
  barIndex?: number;
}
```

### 8.2 Persistence strategies
```typescript
interface DrawingPersistence {
  // Load drawings for a symbol/timeframe
  load(symbolId: string, timeframe: string): Promise<Drawing[]>;
  
  // Save all drawings
  save(symbolId: string, timeframe: string, drawings: Drawing[]): Promise<void>;
  
  // Incremental sync (for real-time collaboration)
  pushChange(change: DrawingChange): Promise<void>;
  subscribeToChanges(callback: (change: DrawingChange) => void): () => void;
}

// Local storage implementation
class LocalDrawingPersistence implements DrawingPersistence {
  private getKey(symbolId: string, timeframe: string): string {
    return `delta:drawings:${symbolId}:${timeframe}`;
  }
  
  async load(symbolId: string, timeframe: string): Promise<Drawing[]> {
    const key = this.getKey(symbolId, timeframe);
    const json = localStorage.getItem(key);
    if (!json) return [];
    
    const storage: DrawingStorage = JSON.parse(json);
    return this.migrate(storage);
  }
  
  async save(symbolId: string, timeframe: string, drawings: Drawing[]): Promise<void> {
    const key = this.getKey(symbolId, timeframe);
    const storage: DrawingStorage = {
      version: 1,
      drawings: drawings.map(serializeDrawing),
    };
    localStorage.setItem(key, JSON.stringify(storage));
  }
  
  private migrate(storage: DrawingStorage): Drawing[] {
    // Handle schema migrations
    return storage.drawings.map(deserializeDrawing);
  }
}
```

### 8.3 Binary wire format (for sync)
```
OVERLAY_ADD / OVERLAY_UPDATE (msgType: 0x0401 / 0x0402)

Payload uses JSON encoding for MVP (simple, debuggable).
Binary encoding reserved for high-volume scenarios.
```

---

## 9) Rendering integration

### 9.1 Drawing render pass
Drawings render after series/indicators, before interaction overlay:
```
1. Background / clear
2. Grid
3. Series (candles/lines)
4. Indicators
5. **Drawings** ← here
6. Text (including drawing labels)
7. Interaction overlay (crosshair, selection handles)
```

### 9.2 Drawing render context
```typescript
interface DrawingRenderContext {
  // GPU resources
  pass: GPURenderPassEncoder;
  pipelines: DrawingPipelines;
  
  // Coordinate transform
  transform: CoordinateTransform;
  
  // Current state
  selectedIds: Set<string>;
  hoveredId: string | null;
  
  // Style resolution
  resolveStyle(drawing: Drawing): ResolvedDrawingStyle;
}
```

### 9.3 Line rendering (reference)
```wgsl
// Analytic anti-aliased line shader
struct LineVertex {
    @location(0) position: vec2<f32>,
    @location(1) direction: vec2<f32>,  // Line direction for AA
    @location(2) color: vec4<f32>,
    @location(3) thickness: f32,
}

@fragment
fn line_fragment(
    @location(0) localPos: vec2<f32>,    // Position relative to line center
    @location(1) color: vec4<f32>,
    @location(2) thickness: f32,
) -> @location(0) vec4<f32> {
    // Distance from line center
    let dist = abs(localPos.y);
    
    // Anti-aliased edge
    let halfThickness = thickness * 0.5;
    let aa = 1.0 - smoothstep(halfThickness - 1.0, halfThickness + 1.0, dist);
    
    return vec4(color.rgb, color.a * aa);
}
```

### 9.4 Selection rendering
```typescript
function renderSelectionHandles(
  ctx: DrawingRenderContext,
  drawing: Drawing
): void {
  const handles = getHandles(drawing);
  
  for (const handle of handles) {
    // Draw handle circle
    renderHandle(ctx, handle.position, {
      radius: 5,
      fillColor: "#ffffff",
      strokeColor: "#0066ff",
      strokeWidth: 2,
    });
  }
  
  // Draw bounding box if selected
  const bounds = computeScreenBounds(drawing, ctx.transform);
  renderDashedRect(ctx, bounds, {
    strokeColor: "#0066ff",
    strokeWidth: 1,
    dashPattern: [4, 4],
  });
}
```

---

## 10) Tile cache interaction

### 10.1 Do drawings invalidate tiles?
**Decision:** Drawings are rendered in a separate pass, NOT cached in tiles.

**Rationale:**
- Drawings change frequently (edits, selection state)
- Tile invalidation for drawing edits would be expensive
- Drawings are typically sparse (low overdraw)

### 10.2 Drawing layer strategy
```
┌─────────────────────────────────────────┐
│  Cached Tile Layer (series + indicators) │
├─────────────────────────────────────────┤
│  Drawing Layer (live render, not cached) │
├─────────────────────────────────────────┤
│  Interaction Layer (crosshair, handles)  │
└─────────────────────────────────────────┘
```

### 10.3 Performance implications
- Drawings always re-render on viewport change
- But drawing complexity is bounded (typically <100 drawings)
- Line drawing is O(n) where n = number of line segments

---

## 11) Implementation checklist

- [ ] Drawing type registry with 15 MVP tools
- [ ] Base drawing object model and serialization
- [ ] Coordinate transform system (data ↔ screen ↔ physical)
- [ ] Spatial indexing for hit testing
- [ ] Per-drawing hit test functions
- [ ] Handle hit testing and rendering
- [ ] Interaction state machine
- [ ] Creation flow for each drawing type
- [ ] Handle dragging with real-time update
- [ ] Snapping system (bar, price, drawing)
- [ ] Undo/redo with command merging
- [ ] Local persistence (localStorage)
- [ ] Drawing render pass integration
- [ ] Selection visualization (handles, bounding box)
- [ ] Keyboard shortcuts (Delete, Escape, Ctrl+Z)
- [ ] Context menu integration
