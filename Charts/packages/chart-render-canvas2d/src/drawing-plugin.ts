/**
 * Drawing Plugin v6 - Production-Ready Object Framework
 * 
 * Features:
 * - Data space storage (time, price)
 * - Smart scale detection  
 * - Continuous updates during drag
 * - Hit detection & hover states
 * - Selection & visual feedback
 * - Object manipulation (move, edit endpoints)
 * - Keyboard support (Escape, Delete)
 * - Proper cleanup (no memory leaks)
 * - Uses native xToTime for accurate transforms
 */

import type {
    ChartPlugin,
    PluginRenderState as CorePluginRenderState,
    PluginPointerEvent,
    TimeMs,
    Chart as CoreChart,
} from '@charts-plus/chart-core';

type Chart = CoreChart & {
    requestRender?: () => void;
};

type PluginRenderState = CorePluginRenderState & {
    plotWidth: number;
    plotHeight: number;
    xToTime: (x: number) => TimeMs;
    yToValue: (y: number) => number;
    timeToX: (t: TimeMs) => number;
    valueToY: (v: number) => number;
    snapX: (x: number) => number;
    snapY: (y: number) => number;
};

// ============================================================================
// Constants
// ============================================================================

const HIT_TOLERANCE = 8; // pixels - distance to consider a "hit"
const HANDLE_RADIUS = 5; // pixels - size of selection handles
const HANDLE_HIT_RADIUS = 10; // pixels - larger radius for easier handle clicking

// ============================================================================
// Data Model
// ============================================================================

export type LineType = 'segment' | 'ray' | 'extended' | 'arrow' | 'horizontal' | 'vertical' | 'anchored_vwap';
// Fib/Channel types (includes retracements, extensions, channels, pitchforks)
export type FibType = 'fib-retracement' | 'fib-extension' | 'fib-channel' | 'parallel-channel'
    | 'regression-trend' | 'std-dev-channel' | 'flat-top-bottom' | 'disjoint-channel' | 'pitchfork';

export type DrawingPoint = {
    time: TimeMs;
    price: number;
};

export type DrawingLine = {
    id: string;
    type: LineType;
    p1: DrawingPoint;
    p2: DrawingPoint;
    color: string;
    width: number;
    dash?: number[];
    showLabel?: boolean;  // For price labels
    labelText?: string;    // Custom label text (defaults to price)
    showRatio?: boolean;   // For time_price - show price/time ratio
};

// Rectangle shape (zone, box, etc.)
export type ZoneType = 'supply' | 'demand' | 'order_block' | 'fvg' | 'breaker' | 'session' | 'or' | 'invalidation';

export const ZONE_COLORS: Record<ZoneType, { fill: string; stroke: string }> = {
    supply: { fill: '#ef5350', stroke: '#c62828' },
    demand: { fill: '#26a69a', stroke: '#00796b' },
    order_block: { fill: '#7c4dff', stroke: '#651fff' },
    fvg: { fill: '#ffd54f', stroke: '#ff8f00' },
    breaker: { fill: '#ff7043', stroke: '#e64a19' },
    session: { fill: '#42a5f5', stroke: '#1976d2' },
    or: { fill: '#66bb6a', stroke: '#388e3c' },
    invalidation: { fill: '#9e9e9e', stroke: '#616161' },
};

export type DrawingRect = {
    id: string;
    p1: DrawingPoint;   // First corner (anchor)
    p2: DrawingPoint;   // Opposite corner
    fillColor: string;
    strokeColor: string;
    strokeWidth: number;
    fillOpacity: number;  // 0-1
    rotation?: number;  // Rotation angle in degrees (0-360)
    // Smart zone extensions
    zoneType?: ZoneType;
    label?: string;
    labelPosition?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center';
};

// Ellipse/Circle shape
export type EllipseType = 'ellipse' | 'circle';
export type DrawingEllipse = {
    id: string;
    type: EllipseType;
    p1: DrawingPoint;   // First corner of bounding box (or center for circle)
    p2: DrawingPoint;   // Opposite corner of bounding box (or edge for circle)
    fillColor: string;
    strokeColor: string;
    strokeWidth: number;
    fillOpacity: number;
};

// Text annotation
export type TextType = 'text' | 'callout' | 'note' | 'price_label';
export type DrawingText = {
    id: string;
    type: TextType;
    position: DrawingPoint;
    content: string;
    fontSize: number;
    fontColor: string;
    backgroundColor: string;
    backgroundOpacity: number;
    padding: number;
};

// Note with icon
export type DrawingNote = {
    id: string;
    position: DrawingPoint;
    text: string;
    icon: '📌' | '📝' | '💡' | '⚠️';
    fontSize: number;
    color: string;
    backgroundColor: string;
    minimized: boolean;  // Collapsed state
};

// Callout with arrow pointer
export type DrawingCallout = {
    id: string;
    textPosition: DrawingPoint;
    targetPosition: DrawingPoint;  // Arrow points here
    text: string;
    fontSize: number;
    fontColor: string;
    backgroundColor: string;
    arrowColor: string;
};

// Cross line (H+V intersection at single point)
export type DrawingCross = {
    id: string;
    time: TimeMs;
    price: number;
    color: string;
    width: number;
};

// Marker/Icon (single-point placement)
export type MarkerType = 'arrow_up' | 'arrow_down' | 'arrow_left' | 'arrow_right' | 'flag' | 'pin'
    | 'swing_high' | 'swing_low' | 'bos' | 'choch' | 'liquidity' | 'invalidation';

export type DrawingMarker = {
    id: string;
    type: MarkerType;
    position: DrawingPoint;
    size: number;
    color: string;
    label?: string;  // Custom label text (e.g., "HH", "LL", "BOS", "CHoCH")
};

// Measure Tools
export type MeasureType = 'price_range' | 'date_range' | 'combined_range' | 'fixed_range_volume_profile';
export type DrawingMeasure = {
    id: string;
    type: MeasureType;
    p1: DrawingPoint;
    p2: DrawingPoint;
    color: string;
    backgroundColor: string;
    backgroundOpacity: number;
    strokeWidth: number;
};

// VWAP Bands - SD bands around anchored VWAP
export type DrawingVWAPBands = {
    id: string;
    anchor: DrawingPoint;  // VWAP anchor point
    vwapColor: string;
    bandColors: string[];  // Colors for ±1σ, ±2σ, ±3σ  
    showBands: [boolean, boolean, boolean];  // Show ±1σ, ±2σ, ±3σ
    fillOpacity: number;
    strokeWidth: number;
    showLabels: boolean;
};

// Gann Tools
export type GannType = 'gann_fan' | 'gann_box' | 'gann_square';
export type DrawingGann = {
    id: string;
    type: GannType;
    p1: DrawingPoint;  // Anchor point
    p2: DrawingPoint;  // Scale reference point
    color: string;
    width: number;
    showLabels: boolean;
    // Gann angles: ratio of price units to time units
    // Standard angles: 1x8, 1x4, 1x3, 1x2, 1x1, 2x1, 3x1, 4x1, 8x1
    angles: { ratio: number; label: string; color: string }[];
};

// Pattern Tools (multi-point patterns)
export type PatternType =
    'xabcd' | 'abcd' | 'triangle' | 'head_shoulders' | 'wedge' | 'double_top' | 'double_bottom' |
    'elliott_impulse' | 'elliott_correction' | 'elliott_triangle' | 'elliott_double' | 'elliott_triple' |
    'cypher' | 'three_drives';
export type DrawingPattern = {
    id: string;
    type: PatternType;
    points: DrawingPoint[];           // Variable number of points (3-5 depending on type)
    labels: string[];                 // Labels for each point (e.g., 'X', 'A', 'B', 'C', 'D')
    color: string;
    width: number;
    showLabels: boolean;
    showRatios: boolean;              // Show Fibonacci ratios between points
    fillColor?: string;
    fillOpacity?: number;
};

// Position/Trade Planning Tools
export type PositionType = 'long' | 'short';
export type DrawingPosition = {
    id: string;
    type: PositionType;
    entryPrice: number;
    targetPrice: number;        // Take profit
    stopPrice: number;          // Stop loss
    startTime: number;          // Left edge time
    endTime: number;            // Right edge time (or extend to edge)
    quantity?: number;          // Optional position size
    profitColor: string;        // Color for profit zone
    lossColor: string;          // Color for loss zone  
    entryColor: string;         // Color for entry line
    opacity: number;            // Zone opacity
    showLabels: boolean;        // Show price labels
    showRatio: boolean;         // Show R:R ratio
    targets?: { price: number; label: string; percentage: number }[];
    scaledEntries?: { price: number; percentage: number }[];
};



// Forecast Tools
export type ForecastType = 'forecast' | 'projection' | 'bars_pattern' | 'ghost_feed';
export type DrawingForecast = {
    id: string;
    type: ForecastType;
    startPoint: DrawingPoint;
    endPoint?: DrawingPoint; // For projection/forecast direction
    data?: any; // For bars pattern / ghost feed data
    color: string;
    width: number;
    style?: 'solid' | 'dashed' | 'dotted';
    showWaveLabels?: boolean;  // For Elliott Wave patterns
};

// Advanced Annotation Tools (Phase 5)
export type PathType = 'curve' | 'double_curve' | 'path' | 'polyline' | 'brush' | 'highlighter';
export type DrawingPath = {
    id: string;
    type: PathType;
    points: DrawingPoint[];
    color: string;
    width: number;
    style?: 'solid' | 'dashed' | 'dotted';
    fillColor?: string;
    fillOpacity?: number;
    smooth: boolean; // bezier smoothing
    closed?: boolean; // connect last to first
};

export type DrawingArc = {
    id: string;
    // Defined by 3 points: Start, End, and a control point for arc radius/curvature
    p1: DrawingPoint; // Start
    p2: DrawingPoint; // End
    p3: DrawingPoint; // Control
    color: string;
    width: number;
    style?: 'solid' | 'dashed' | 'dotted';
    fillColor?: string;
    fillOpacity?: number;
};

// Fibonacci level definition
export type FibLevel = {
    ratio: number;      // 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.272, 1.618, etc.
    color: string;
    width: number;
    dash?: number[];
    showLabel: boolean;
};

// Default Fibonacci levels
export const DEFAULT_FIB_LEVELS: FibLevel[] = [
    { ratio: 0, color: '#787b86', width: 1, showLabel: true },
    { ratio: 0.236, color: '#f23645', width: 1, showLabel: true },
    { ratio: 0.382, color: '#ff9800', width: 1, showLabel: true },
    { ratio: 0.5, color: '#4caf50', width: 1, showLabel: true },
    { ratio: 0.618, color: '#2196f3', width: 1, showLabel: true },
    { ratio: 0.786, color: '#9c27b0', width: 1, showLabel: true },
    { ratio: 1, color: '#787b86', width: 1, showLabel: true },
];

export const DEFAULT_FIB_EXTENSION_LEVELS: FibLevel[] = [
    // Negative extensions (project below 0%)
    { ratio: -0.618, color: '#673ab7', width: 1, dash: [4, 4], showLabel: true },
    { ratio: -0.272, color: '#00bcd4', width: 1, dash: [4, 4], showLabel: true },
    // Standard retracement levels
    ...DEFAULT_FIB_LEVELS,
    // Positive extensions (project above 100%)
    { ratio: 1.272, color: '#00bcd4', width: 1, showLabel: true },
    { ratio: 1.618, color: '#e91e63', width: 1, showLabel: true },
    { ratio: 2.618, color: '#673ab7', width: 1, showLabel: true },
];

// For Fib Channel - fewer levels, parallel diagonal lines
export const DEFAULT_FIB_CHANNEL_LEVELS: FibLevel[] = [
    { ratio: 0, color: '#787b86', width: 2, showLabel: true },
    { ratio: 0.236, color: '#f23645', width: 1, showLabel: true },
    { ratio: 0.382, color: '#ff9800', width: 1, showLabel: true },
    { ratio: 0.5, color: '#4caf50', width: 1.5, showLabel: true },
    { ratio: 0.618, color: '#2196f3', width: 1.5, showLabel: true },
    { ratio: 0.786, color: '#9c27b0', width: 1, showLabel: true },
    { ratio: 1, color: '#787b86', width: 2, showLabel: true },
];

// For Parallel Channel - simple 2-line + optional median
export const DEFAULT_PARALLEL_CHANNEL_LEVELS: FibLevel[] = [
    { ratio: 0, color: '#787b86', width: 2, showLabel: false },
    { ratio: 0.5, color: '#787b86', width: 1, showLabel: false, dash: [4, 4] },
    { ratio: 1, color: '#787b86', width: 2, showLabel: false },
];

// For Pitchfork - median line + tines at 0.25, 0.5, 0.75, 1
export const DEFAULT_PITCHFORK_LEVELS: FibLevel[] = [
    { ratio: 0, color: '#787b86', width: 2, showLabel: false },      // Median line
    { ratio: 0.25, color: '#787b86', width: 1, showLabel: false, dash: [4, 4] },
    { ratio: 0.5, color: '#787b86', width: 1, showLabel: false, dash: [4, 4] },
    { ratio: 0.75, color: '#787b86', width: 1, showLabel: false, dash: [4, 4] },
    { ratio: 1, color: '#787b86', width: 2, showLabel: false },
];

// For Std Dev Channel - ±2σ bands (simple visualization)
export const DEFAULT_STD_DEV_CHANNEL_LEVELS: FibLevel[] = [
    { ratio: -2, color: '#2962ff', width: 1, showLabel: true, dash: [4, 4] },  // -2σ
    { ratio: 0, color: '#2962ff', width: 2, showLabel: false },                // Regression line
    { ratio: 2, color: '#2962ff', width: 1, showLabel: true, dash: [4, 4] },   // +2σ
];

// For Regression Trend - multiple std dev levels
export const DEFAULT_REGRESSION_TREND_LEVELS: FibLevel[] = [
    { ratio: -3, color: '#f23645', width: 1, showLabel: true, dash: [2, 2] },  // -3σ
    { ratio: -2, color: '#ff9800', width: 1, showLabel: true, dash: [4, 4] },  // -2σ
    { ratio: -1, color: '#ffeb3b', width: 1, showLabel: true, dash: [4, 4] },  // -1σ
    { ratio: 0, color: '#2962ff', width: 2, showLabel: false },                // Regression line
    { ratio: 1, color: '#ffeb3b', width: 1, showLabel: true, dash: [4, 4] },   // +1σ
    { ratio: 2, color: '#ff9800', width: 1, showLabel: true, dash: [4, 4] },   // +2σ
    { ratio: 3, color: '#f23645', width: 1, showLabel: true, dash: [2, 2] },   // +3σ
];

// For Flat Top/Bottom - just 2 lines
export const DEFAULT_FLAT_CHANNEL_LEVELS: FibLevel[] = [
    { ratio: 0, color: '#787b86', width: 2, showLabel: false },    // Horizontal line
    { ratio: 1, color: '#787b86', width: 2, showLabel: false },    // Sloped line
];

export type DrawingFib = {
    id: string;
    type: FibType;
    p1: DrawingPoint;   // Point A: Start of impulse (or first point of trend line)
    p2: DrawingPoint;   // Point B: End of impulse (or second point of trend line)
    p3?: DrawingPoint;  // Point C: End of retracement (for Extension) or channel width (for Channel)
    p4?: DrawingPoint;  // Point D: For 4-point tools (disjoint channel)
    levels: FibLevel[];
    showBackground: boolean;
    backgroundColor: string;
    regressionData?: {  // For statistical channels (regression-trend, std-dev-channel)
        slope: number;
        intercept: number;
        stdDev: number;
        dataPointCount: number;
        startTime: TimeMs;  // Time range used for regression calculation
        endTime: TimeMs;
    };
};

// Fibonacci Time Zones
export type DrawingFibTimeZones = {
    id: string;
    startTime: TimeMs;
    endTime: TimeMs;
    color: string;
    width: number;
};

// Fibonacci Speed Fan - angled rays at Fib slope ratios
export type DrawingFibSpeedFan = {
    id: string;
    anchor: DrawingPoint;
    reference: DrawingPoint;
    levels: FibLevel[];  // 0.236, 0.382, 0.5, 0.618, 1.0
};

// Cyclic Lines - evenly spaced vertical lines
export type DrawingCyclicLines = {
    id: string;
    startTime: TimeMs;
    interval: number;  // Time interval in ms
    count: number;     // Number of lines to draw
    color: string;
    width: number;
};

// Time Cycles - periodic time markers
export type DrawingTimeCycles = {
    id: string;
    startTime: TimeMs;
    cycleLength: number;  // Length of one cycle in ms
    cycles: number;       // Number of cycles
    color: string;
    width: number;
};

// Sine Line - sine wave overlay
export type DrawingSineLine = {
    id: string;
    startPoint: DrawingPoint;
    endPoint: DrawingPoint;
    amplitude: number;    // Wave amplitude
    frequency: number;    // Number of waves
    color: string;
    width: number;
};

// Fibonacci Spiral - golden spiral geometry
export type DrawingFibSpiral = {
    id: string;
    center: DrawingPoint;
    startRadius: number;
    direction: 'clockwise' | 'counterclockwise';
    color: string;
    width: number;
};

export type DrawingMode = 'idle' | 'drawing' | 'drawing-p3' | 'drawing-p4' | 'moving' | 'editing' | 'drawing-brush' | 'drawing-path' | 'drawing-arc-p3';
export type DrawingToolType = 'select' | 'line' | 'ray' | 'extended' | 'arrow' | 'horizontal' | 'vertical' | 'cross_line' | 'fib-retracement' | 'fib-extension' | 'fib-channel' | 'parallel-channel' | 'regression-trend' | 'std-dev-channel' | 'flat-top-bottom' | 'disjoint-channel' | 'pitchfork' | 'rectangle' | 'ellipse' | 'circle' | 'text' | 'marker' | 'arrow_up' | 'arrow_down' | 'arrow_left' | 'arrow_right' | 'flag' | 'pin' | 'price_range' | 'date_range' | 'combined_range' | 'gann_fan' | 'gann_box' | 'xabcd' | 'abcd' | 'triangle' | 'head_shoulders' | 'long_position' | 'short_position' | 'multi_target' | 'scaled_entry' | 'forecast' | 'projection' | 'bars_pattern' | 'ghost_feed' | 'curve' | 'double_curve' | 'path' | 'polyline' | 'brush' | 'highlighter' | 'arc' | 'anchored_vwap' | 'vwap_bands' | 'fixed_range_volume_profile';
export type HandleType = 'p1' | 'p2' | 'p3' | 'body';

export type DrawingPluginState = {
    lines: DrawingLine[];
    fibs: DrawingFib[];
    fibTimeZones: DrawingFibTimeZones[];
    fibSpeedFans: DrawingFibSpeedFan[];
    cyclicLines: DrawingCyclicLines[];
    timeCycles: DrawingTimeCycles[];
    sineLines: DrawingSineLine[];
    fibSpirals: DrawingFibSpiral[];
    rects: DrawingRect[];
    ellipses: DrawingEllipse[];
    texts: DrawingText[];
    crosses: DrawingCross[];
    notes: DrawingNote[];
    callouts: DrawingCallout[];
    markers: DrawingMarker[];
    measures: DrawingMeasure[];
    ganns: DrawingGann[];
    patterns: DrawingPattern[];
    positions: DrawingPosition[];
    forecasts: DrawingForecast[]; // New Forecast type
    paths: DrawingPath[]; // New Path type
    arcs: DrawingArc[]; // New Arc type
    vwapBands: DrawingVWAPBands[]; // VWAP with SD bands
    mode: DrawingMode;
    activeTool: DrawingToolType;
    pendingPoint: DrawingPoint | null;
    pendingFibId: string | null;  // For 3-point tools: ID of Fib awaiting p3
    selectedLineId: string | null;
    selectedFibId: string | null;
    selectedRectId: string | null;
    selectedEllipseId: string | null;
    selectedTextId: string | null;
    selectedCrossId: string | null;
    selectedNoteId: string | null;
    selectedCalloutId: string | null;
    selectedMarkerId: string | null;
    selectedMeasureId: string | null;
    selectedGannId: string | null;
    selectedPatternId: string | null;
    selectedPositionId: string | null;
    selectedForecastId: string | null; // New Forecast selection
    selectedPathId: string | null; // New Path selection
    selectedArcId: string | null; // New Arc selection
    pendingPatternPoints: DrawingPoint[];  // For multi-point pattern creation
    hoveredLineId: string | null;
    hoveredFibId: string | null;
    hoveredRectId: string | null;
    hoveredEllipseId: string | null;
    hoveredTextId: string | null;
    hoveredCrossId: string | null;
    hoveredNoteId: string | null;
    hoveredCalloutId: string | null;
    hoveredMarkerId: string | null;
    hoveredMeasureId: string | null;
    hoveredGannId: string | null;
    hoveredPatternId: string | null;
    hoveredPositionId: string | null;
    hoveredForecastId: string | null; // New Forecast hover
    hoveredPathId: string | null; // New Path hover
    hoveredArcId: string | null; // New Arc hover
    activeHandle: HandleType | null;
    dragStartPoint: { x: number; y: number } | null;
    dragStartData: { p1: DrawingPoint; p2: DrawingPoint; p3?: DrawingPoint } | null;
    dataAccessor: ((from: TimeMs, to: TimeMs) => Array<{ t: TimeMs; c: number; h: number; l: number; o: number }>) | null; // For statistical channels
};

export type DrawingPluginAPI = {
    setTool: (tool: DrawingToolType) => void;
    getTool: () => DrawingToolType;
    getLines: () => readonly DrawingLine[];
    getFibs: () => readonly DrawingFib[];
    getRects: () => readonly DrawingRect[];
    getForecasts: () => readonly DrawingForecast[]; // New Forecast getter
    getPaths: () => readonly DrawingPath[]; // New Path getter
    getArcs: () => readonly DrawingArc[]; // New Arc getter
    addLine: (line: Omit<DrawingLine, 'id'>) => string;
    addFib: (fib: Omit<DrawingFib, 'id'>) => string;
    addRect: (rect: Omit<DrawingRect, 'id'>) => string;
    addForecast: (forecast: Omit<DrawingForecast, 'id'>) => string; // New Forecast adder
    addPath: (path: Omit<DrawingPath, 'id'>) => string; // New Path adder
    addArc: (arc: Omit<DrawingArc, 'id'>) => string; // New Arc adder
    removeLine: (id: string) => void;
    removeFib: (id: string) => void;
    removeRect: (id: string) => void;
    removeForecast: (id: string) => void; // New Forecast remover
    removePath: (id: string) => void; // New Path remover
    removeArc: (id: string) => void; // New Arc remover
    clearAll: () => void;
    cancelDrawing: () => void;
    deleteSelected: () => void;
    getSelectedLine: () => DrawingLine | null;
    getSelectedFib: () => DrawingFib | null;
    getSelectedRect: () => DrawingRect | null;
    getSelectedForecast: () => DrawingForecast | null; // New Forecast getter
    destroy: () => void;
    onLineComplete: (callback: (line: DrawingLine) => void) => void;
    onFibComplete: (callback: (fib: DrawingFib) => void) => void;
    onRectComplete: (callback: (rect: DrawingRect) => void) => void;
    onForecastComplete: (callback: (forecast: DrawingForecast) => void) => void;
    onPathComplete: (callback: (path: DrawingPath) => void) => void;
    onArcComplete: (callback: (arc: DrawingArc) => void) => void;
    getSelectedPath: () => DrawingPath | null;
    getSelectedArc: () => DrawingArc | null;
    setAutoSwitchToSelect: (enabled: boolean) => void;
    // Control Dock Methods
    setVisible: (visible: boolean) => void;
    setLocked: (locked: boolean) => void;
    setEraserMode: (enabled: boolean) => void;
    setSnapEnabled: (enabled: boolean) => void;
    isVisible: () => boolean;
    isLocked: () => boolean;
    isEraserMode: () => boolean;
    isSnapEnabled: () => boolean;
    setDataAccessor: (accessor: (from: TimeMs, to: TimeMs) => Array<{ t: TimeMs; c: number; h: number; l: number; o: number }>) => void;
};

// NEW-CH-002: Deterministic, collision-free ID generation
// Replaces Math.random() which is non-cryptographic and can collide
let _drawingIdCounter = 0;
function generateDrawingId(prefix: string): string {
    _drawingIdCounter++;
    const timestamp = Date.now().toString(36);
    const counter = _drawingIdCounter.toString(36).padStart(4, '0');
    return `${prefix}_${timestamp}_${counter}`;
}

const generateLineId = () => generateDrawingId('line');
const generateFibId = () => generateDrawingId('fib');
const generateRectId = () => generateDrawingId('rect');
const generateEllipseId = () => generateDrawingId('ellipse');
const generateTextId = () => generateDrawingId('text');
const generateMarkerId = () => generateDrawingId('marker');
const generateMeasureId = () => generateDrawingId('measure');
const generateGannId = () => generateDrawingId('gann');
const generatePatternId = () => generateDrawingId('pattern');
const generatePositionId = () => generateDrawingId('pos');
const generatePlanningId = () => generateDrawingId('plan');
const generateForecastId = () => generateDrawingId('fcst');
const generatePathId = () => generateDrawingId('path');
const generateArcId = () => generateDrawingId('arc');

//Pattern point requirements
const PATTERN_POINT_COUNTS: Record<PatternType, number> = {
    xabcd: 5,
    abcd: 4,
    triangle: 3,
    head_shoulders: 5,
    wedge: 4,
    double_top: 3,
    double_bottom: 3,
    elliott_impulse: 5,
    elliott_correction: 3,
    elliott_triangle: 5,
    elliott_double: 6,
    elliott_triple: 9,
    cypher: 5,
    three_drives: 6,
};

// Default pattern labels
const PATTERN_LABELS: Record<PatternType, string[]> = {
    xabcd: ['X', 'A', 'B', 'C', 'D'],
    abcd: ['A', 'B', 'C', 'D'],
    triangle: ['1', '2', '3'],
    head_shoulders: ['LS', 'H', 'RS', 'NL', 'NR'],  // Left Shoulder, Head, Right Shoulder, Neckline Left/Right
    wedge: ['1', '2', '3', '4'],
    double_top: ['1', '2', '3'],
    double_bottom: ['1', '2', '3'],
    elliott_impulse: ['1', '2', '3', '4', '5'],
    elliott_correction: ['A', 'B', 'C'],
    elliott_triangle: ['A', 'B', 'C', 'D', 'E'],
    elliott_double: ['W', 'X', 'Y', 'X2', 'Z'],
    elliott_triple: ['W', 'X', 'Y', 'X2', 'Z', 'X3', 'Z2'],
    cypher: ['X', 'A', 'B', 'C', 'D'],
    three_drives: ['1', 'A', '2', 'B', '3', 'C'],
};

// Default Gann Fan angles (price:time ratios)
const DEFAULT_GANN_ANGLES = [
    { ratio: 8, label: '8x1', color: '#f23645' },    // Steepest
    { ratio: 4, label: '4x1', color: '#ff9800' },
    { ratio: 3, label: '3x1', color: '#ffeb3b' },
    { ratio: 2, label: '2x1', color: '#8bc34a' },
    { ratio: 1, label: '1x1', color: '#2962ff' },    // 45 degree
    { ratio: 0.5, label: '1x2', color: '#00bcd4' },
    { ratio: 0.333, label: '1x3', color: '#9c27b0' },
    { ratio: 0.25, label: '1x4', color: '#e91e63' },
    { ratio: 0.125, label: '1x8', color: '#795548' }, // Flattest
];

// ============================================================================
// Geometry Utilities
// ============================================================================

/**
 * Calculate perpendicular distance from point to line segment
 */
const pointToLineDistance = (
    px: number, py: number,
    x1: number, y1: number,
    x2: number, y2: number
): number => {
    const dx = x2 - x1;
    const dy = y2 - y1;
    const lengthSq = dx * dx + dy * dy;

    if (lengthSq === 0) {
        return Math.hypot(px - x1, py - y1);
    }

    let t = ((px - x1) * dx + (py - y1) * dy) / lengthSq;
    t = Math.max(0, Math.min(1, t));

    const projX = x1 + t * dx;
    const projY = y1 + t * dy;

    return Math.hypot(px - projX, py - projY);
};

/**
 * Check if point is near a handle
 */
const isNearHandle = (
    px: number, py: number,
    hx: number, hy: number,
    radius: number
): boolean => {
    return Math.hypot(px - hx, py - hy) <= radius;
};

// ============================================================================
// Statistical Calculation Functions for Channels
// ============================================================================

/**
 * Calculate linear regression line for a set of price data points
 * Returns slope and intercept for y = slope * x + intercept
 */
const calculateLinearRegression = (
    data: Array<{ t: TimeMs; c: number }>,
    startTime: TimeMs
): { slope: number; intercept: number; points: Array<{ x: number; y: number }> } => {
    if (data.length === 0) {
        return { slope: 0, intercept: 0, points: [] };
    }

    const n = data.length;
    let sumX = 0;
    let sumY = 0;
    let sumXY = 0;
    let sumX2 = 0;

    // Convert to indexed points  
    const points = data.map((d, i) => ({
        x: i,
        y: d.c,
        time: d.t
    }));

    points.forEach((p) => {
        sumX += p.x;
        sumY += p.y;
        sumXY += p.x * p.y;
        sumX2 += p.x * p.x;
    });

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
    const intercept = (sumY - slope * sumX) / n;

    return { slope, intercept, points };
};

/**
 * Calculate standard deviation of prices from regression line
 */
const calculateStandardDeviation = (
    points: Array<{ x: number; y: number }>,
    regressionLine: { slope: number; intercept: number }
): number => {
    if (points.length === 0) return 0;

    const deviations = points.map((p) => {
        const expected = regressionLine.slope * p.x + regressionLine.intercept;
        return p.y - expected;
    });

    const sumSquaredDeviations = deviations.reduce((sum, dev) => sum + dev * dev, 0);
    const variance = sumSquaredDeviations / points.length;
    const stdDev = Math.sqrt(variance);

    return stdDev;
};

// ============================================================================
// Plugin Factory
// ============================================================================

export const createDrawingPlugin = (): ChartPlugin<CanvasRenderingContext2D> & { api: DrawingPluginAPI } => {
    const state: DrawingPluginState = {
        lines: [],
        fibs: [],
        fibTimeZones: [],
        fibSpeedFans: [],
        cyclicLines: [],
        timeCycles: [],
        sineLines: [],
        fibSpirals: [],
        rects: [],
        ellipses: [],
        texts: [],
        crosses: [],
        notes: [],
        callouts: [],
        markers: [],
        measures: [],
        ganns: [],
        patterns: [],
        positions: [],
        forecasts: [],
        paths: [],
        arcs: [],
        vwapBands: [],
        mode: 'idle',
        activeTool: 'select',
        pendingPoint: null,
        pendingFibId: null,
        pendingPatternPoints: [],
        selectedLineId: null,
        selectedFibId: null,
        selectedRectId: null,
        selectedEllipseId: null,
        selectedTextId: null,
        selectedCrossId: null,
        selectedNoteId: null,
        selectedCalloutId: null,
        selectedMarkerId: null,
        selectedMeasureId: null,
        selectedGannId: null,
        selectedPatternId: null,
        selectedPositionId: null,
        selectedForecastId: null,
        selectedPathId: null,
        selectedArcId: null,
        hoveredLineId: null,
        hoveredFibId: null,
        hoveredRectId: null,
        hoveredEllipseId: null,
        hoveredTextId: null,
        hoveredCrossId: null,
        hoveredNoteId: null,
        hoveredCalloutId: null,
        hoveredMarkerId: null,
        hoveredMeasureId: null,
        hoveredGannId: null,
        hoveredPatternId: null,
        hoveredPositionId: null,
        hoveredForecastId: null,
        hoveredPathId: null,
        hoveredArcId: null,
        activeHandle: null,
        dragStartPoint: null,
        dragStartData: null,
        dataAccessor: null, // For statistical channel calculations
    };



    let chartRef: any = null;
    let currentMouseX = 0;
    let currentMouseY = 0;
    let constrainedMouseX = 0;
    let constrainedMouseY = 0;
    let isShiftPressed = false;
    let lastRenderState: PluginRenderState | null = null;
    let keydownHandler: ((e: KeyboardEvent) => void) | null = null;
    let keyupHandler: ((e: KeyboardEvent) => void) | null = null;
    let isDestroyed = false;
    let lineCompleteCallback: ((line: DrawingLine) => void) | null = null;
    let fibCompleteCallback: ((fib: DrawingFib) => void) | null = null;
    let rectCompleteCallback: ((rect: DrawingRect) => void) | null = null;
    let drawingsChangedCallback: (() => void) | null = null;
    let autoSwitchToSelect = true; // Default: auto-switch after completing a line

    // Control dock state
    let drawingsVisible = true;
    let drawingsLocked = false;
    let eraserModeEnabled = false;
    let snapEnabled = true;

    // ========================================================================
    // Cursor Management
    // ========================================================================

    const resetCursor = () => {
        document.body.style.cursor = '';
    };

    const setCursor = (cursor: string) => {
        document.body.style.cursor = cursor;
    };

    // ========================================================================
    // API
    // ========================================================================

    const api: DrawingPluginAPI = {
        setTool: (tool) => {
            // Auto-cancel any pending drawing when switching tools
            if (state.mode.startsWith('drawing')) {
                api.cancelDrawing();
            }

            state.activeTool = tool;
            state.mode = 'idle';
            state.pendingPoint = null;
            state.hoveredLineId = null;
            resetCursor();
            if (tool !== 'select') {
                state.selectedLineId = null;
            }
        },
        getTool: () => state.activeTool,
        getLines: () => state.lines,

        getForecasts: () => state.forecasts,
        getPaths: () => state.paths,
        getArcs: () => state.arcs,

        addLine: (line) => {
            const id = generateLineId();
            state.lines.push({ ...line, id });
            chartRef?.requestRender?.();
            return id;
        },
        removeLine: (id) => {
            const idx = state.lines.findIndex(l => l.id === id);
            if (idx >= 0) state.lines.splice(idx, 1);
            if (state.selectedLineId === id) state.selectedLineId = null;
            if (state.hoveredLineId === id) state.hoveredLineId = null;
        },
        clearAll: () => {
            state.lines = [];
            state.fibs = [];
            state.rects = [];
            state.ellipses = [];
            state.texts = [];
            state.markers = [];
            state.measures = [];
            state.ganns = [];
            state.patterns = [];
            state.positions = [];
            state.forecasts = [];
            state.paths = [];
            state.arcs = [];
            state.mode = 'idle';
            state.pendingPoint = null;
            state.pendingPatternPoints = [];
            state.selectedLineId = null;
            state.selectedFibId = null;
            state.selectedRectId = null;
            state.selectedEllipseId = null;
            state.selectedTextId = null;
            state.selectedMarkerId = null;
            state.selectedMeasureId = null;
            state.selectedGannId = null;
            state.selectedPatternId = null;
            state.selectedPositionId = null;
            state.selectedForecastId = null;
            state.selectedPathId = null;
            state.selectedArcId = null;
            state.hoveredLineId = null;
            state.hoveredFibId = null;
            state.hoveredRectId = null;
            state.hoveredEllipseId = null;
            state.hoveredTextId = null;
            state.hoveredMarkerId = null;
            state.hoveredMeasureId = null;
            state.hoveredGannId = null;
            state.hoveredPatternId = null;
            state.hoveredPositionId = null;
            state.hoveredForecastId = null;
            state.hoveredPathId = null;
            state.hoveredArcId = null;
            resetCursor();
        },
        cancelDrawing: () => {
            // If in 3-point mode, remove the pending Fib
            if (state.mode === 'drawing-p3' && state.pendingFibId) {
                api.removeFib(state.pendingFibId);
                state.pendingFibId = null;
            }
            // Clear pending pattern points
            state.pendingPatternPoints = [];
            state.mode = 'idle';
            state.pendingPoint = null;
            // Reset cursor to default
            resetCursor();
        },
        deleteSelected: () => {
            if (state.selectedLineId) {
                api.removeLine(state.selectedLineId);
            } else if (state.selectedFibId) {
                api.removeFib(state.selectedFibId);
            } else if (state.selectedRectId) {
                api.removeRect(state.selectedRectId);
            } else if (state.selectedEllipseId) {
                state.ellipses = state.ellipses.filter(e => e.id !== state.selectedEllipseId);
                state.selectedEllipseId = null;
            } else if (state.selectedTextId) {
                state.texts = state.texts.filter(t => t.id !== state.selectedTextId);
                state.selectedTextId = null;
            } else if (state.selectedCrossId) {
                state.crosses = state.crosses.filter(c => c.id !== state.selectedCrossId);
                state.selectedCrossId = null;
            } else if (state.selectedNoteId) {
                state.notes = state.notes.filter(n => n.id !== state.selectedNoteId);
                state.selectedNoteId = null;
            } else if (state.selectedCalloutId) {
                state.callouts = state.callouts.filter(c => c.id !== state.selectedCalloutId);
                state.selectedCalloutId = null;
            } else if (state.selectedMarkerId) {
                state.markers = state.markers.filter(m => m.id !== state.selectedMarkerId);
                state.selectedMarkerId = null;
            } else if (state.selectedMeasureId) {
                state.measures = state.measures.filter(m => m.id !== state.selectedMeasureId);
                state.selectedMeasureId = null;
            } else if (state.selectedGannId) {
                state.ganns = state.ganns.filter(g => g.id !== state.selectedGannId);
                state.selectedGannId = null;
            } else if (state.selectedPatternId) {
                state.patterns = state.patterns.filter(p => p.id !== state.selectedPatternId);
                state.selectedPatternId = null;
            } else if (state.selectedPositionId) {
                state.positions = state.positions.filter(p => p.id !== state.selectedPositionId);
                state.selectedPositionId = null;
            } else if (state.selectedForecastId) {
                api.removeForecast(state.selectedForecastId);
            } else if (state.selectedPathId) {
                api.removePath(state.selectedPathId);
            } else if (state.selectedArcId) {
                api.removeArc(state.selectedArcId);
            }
        },
        getSelectedLine: () => {
            return state.lines.find(l => l.id === state.selectedLineId) ?? null;
        },
        getFibs: () => state.fibs,
        addFib: (fib) => {
            const id = generateFibId();
            state.fibs.push({ ...fib, id });
            return id;
        },
        removeFib: (id) => {
            const idx = state.fibs.findIndex(f => f.id === id);
            if (idx >= 0) state.fibs.splice(idx, 1);
            if (state.selectedFibId === id) state.selectedFibId = null;
            if (state.hoveredFibId === id) state.hoveredFibId = null;
        },
        getSelectedFib: () => {
            return state.fibs.find(f => f.id === state.selectedFibId) ?? null;
        },
        // Rectangle methods
        getRects: () => state.rects,
        addRect: (rect) => {
            const id = generateRectId();
            state.rects.push({ ...rect, id });
            return id;
        },
        removeRect: (id) => {
            const idx = state.rects.findIndex(r => r.id === id);
            if (idx >= 0) state.rects.splice(idx, 1);
            if (state.selectedRectId === id) state.selectedRectId = null;
            if (state.hoveredRectId === id) state.hoveredRectId = null;
        },
        getSelectedRect: () => {
            return state.rects.find(r => r.id === state.selectedRectId) ?? null;
        },
        // Forecast methods
        addForecast: (forecast) => {
            const id = generateForecastId();
            state.forecasts.push({ ...forecast, id });
            return id;
        },
        removeForecast: (id) => {
            const idx = state.forecasts.findIndex(f => f.id === id);
            if (idx >= 0) state.forecasts.splice(idx, 1);
            if (state.selectedForecastId === id) state.selectedForecastId = null;
            if (state.hoveredForecastId === id) state.hoveredForecastId = null;
        },
        // Path methods
        addPath: (path) => {
            const id = generatePathId();
            state.paths.push({ ...path, id });
            return id;
        },
        removePath: (id) => {
            const idx = state.paths.findIndex(p => p.id === id);
            if (idx >= 0) state.paths.splice(idx, 1);
            if (state.selectedPathId === id) state.selectedPathId = null;
            if (state.hoveredPathId === id) state.hoveredPathId = null;
        },
        // Arc methods
        addArc: (arc) => {
            const id = generateArcId();
            state.arcs.push({ ...arc, id });
            return id;
        },
        removeArc: (id) => {
            const idx = state.arcs.findIndex(a => a.id === id);
            if (idx >= 0) state.arcs.splice(idx, 1);
            if (state.selectedArcId === id) state.selectedArcId = null;
            if (state.hoveredArcId === id) state.hoveredArcId = null;
        },
        getSelectedForecast: () => {
            return state.forecasts.find(f => f.id === state.selectedForecastId) ?? null;
        },
        getSelectedPath: () => {
            return state.paths.find(p => p.id === state.selectedPathId) ?? null;
        },
        getSelectedArc: () => {
            return state.arcs.find(a => a.id === state.selectedArcId) ?? null;
        },
        onForecastComplete: (callback) => {
            // Implementation pending or add callback storage
        },
        onPathComplete: (callback) => {
            // Implementation pending
        },
        onArcComplete: (callback) => {
            // Implementation pending
        },
        destroy: () => {
            if (isDestroyed) return;
            isDestroyed = true;

            if (keydownHandler) {
                window.removeEventListener('keydown', keydownHandler);
                keydownHandler = null;
            }

            resetCursor();

            state.lines = [];
            state.fibs = [];
            state.rects = [];
            state.selectedLineId = null;
            state.selectedFibId = null;
            state.selectedRectId = null;
            state.hoveredLineId = null;
            state.hoveredFibId = null;
            state.hoveredRectId = null;
            chartRef = null;
            lastRenderState = null;
        },
        onLineComplete: (callback) => {
            lineCompleteCallback = callback;
        },
        onFibComplete: (callback) => {
            fibCompleteCallback = callback;
        },
        onRectComplete: (callback) => {
            rectCompleteCallback = callback;
        },
        setAutoSwitchToSelect: (enabled) => {
            autoSwitchToSelect = enabled;
        },
        // Control Dock Methods
        setVisible: (visible) => {
            drawingsVisible = visible;
        },
        setLocked: (locked) => {
            drawingsLocked = locked;
        },
        setEraserMode: (enabled) => {
            eraserModeEnabled = enabled;
        },
        setSnapEnabled: (enabled) => {
            snapEnabled = enabled;
        },
        isVisible: () => drawingsVisible,
        isLocked: () => drawingsLocked,
        isEraserMode: () => eraserModeEnabled,
        isSnapEnabled: () => snapEnabled,
        setDataAccessor: (accessor) => {
            state.dataAccessor = accessor;
        },
    };

    // ========================================================================
    // Hit Detection
    // ========================================================================

    const getLineScreenCoords = (line: DrawingLine, rs: PluginRenderState) => {
        const x1 = rs.timeToX(line.p1.time);
        const y1 = rs.valueToY(line.p1.price);
        const x2 = rs.timeToX(line.p2.time);
        const y2 = rs.valueToY(line.p2.price);

        if (line.type === 'horizontal') {
            return { x1: rs.plotRect.x, y1, x2: rs.plotRect.x + rs.plotRect.width, y2: y1 };
        } else if (line.type === 'vertical') {
            return { x1, y1: rs.plotRect.y, x2: x1, y2: rs.plotRect.y + rs.plotRect.height };
        }
        return { x1, y1, x2, y2 };
    };

    // Helper: Constrain point to 0°, 45°, 90° angles when shift is pressed
    const constrainToAngle = (x1: number, y1: number, x2: number, y2: number): { x: number; y: number } => {
        if (!isShiftPressed) return { x: x2, y: y2 };

        const dx = x2 - x1;
        const dy = y2 - y1;
        const angle = Math.atan2(dy, dx);
        const length = Math.sqrt(dx * dx + dy * dy);

        // Find nearest constraint angle (0°, 45°, 90°, 135°, 180°, -45°, -90°, -135°)
        const constrainedAngle = Math.round(angle / (Math.PI / 4)) * (Math.PI / 4);

        return {
            x: x1 + length * Math.cos(constrainedAngle),
            y: y1 + length * Math.sin(constrainedAngle),
        };
    };


    const hitTestLine = (
        mx: number, my: number,
        line: DrawingLine,
        rs: PluginRenderState
    ): HandleType | null => {
        const { x1, y1, x2, y2 } = getLineScreenCoords(line, rs);

        // Check handles first (if selected)
        if (state.selectedLineId === line.id) {
            if (isNearHandle(mx, my, x1, y1, HANDLE_HIT_RADIUS)) return 'p1';
            if (line.type !== 'horizontal' && line.type !== 'vertical') {
                if (isNearHandle(mx, my, x2, y2, HANDLE_HIT_RADIUS)) return 'p2';
            }
        }

        // Check line body
        const dist = pointToLineDistance(mx, my, x1, y1, x2, y2);
        if (dist <= HIT_TOLERANCE) return 'body';

        return null;
    };

    const findLineAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { line: DrawingLine; handle: HandleType } | null => {
        // Check selected line first (for handle priority)
        if (state.selectedLineId) {
            const selected = state.lines.find(l => l.id === state.selectedLineId);
            if (selected) {
                const handle = hitTestLine(mx, my, selected, rs);
                if (handle) return { line: selected, handle };
            }
        }

        // Check all lines (reverse order = top first)
        for (let i = state.lines.length - 1; i >= 0; i--) {
            const line = state.lines[i];
            const handle = hitTestLine(mx, my, line, rs);
            if (handle) return { line, handle };
        }

        return null;
    };

    // ========================================================================
    // Fibonacci Hit Detection
    // ========================================================================

    const hitTestFib = (
        mx: number, my: number,
        fib: DrawingFib,
        rs: PluginRenderState
    ): HandleType | null => {
        const y1 = rs.valueToY(fib.p1.price);
        const y2 = rs.valueToY(fib.p2.price);
        const x1 = rs.timeToX(fib.p1.time);
        const x2 = rs.timeToX(fib.p2.time);
        const plotLeft = rs.plotRect.x;
        const plotRight = rs.plotRect.x + rs.plotRect.width;

        // Check handles first (if selected)
        if (state.selectedFibId === fib.id) {
            if (isNearHandle(mx, my, x1, y1, HANDLE_HIT_RADIUS)) return 'p1';
            if (isNearHandle(mx, my, x2, y2, HANDLE_HIT_RADIUS)) return 'p2';
            // Check p3 handle for 3-point fibs
            if (fib.p3) {
                const x3 = rs.timeToX(fib.p3.time);
                const y3 = rs.valueToY(fib.p3.price);
                if (isNearHandle(mx, my, x3, y3, HANDLE_HIT_RADIUS)) return 'p3';
            }
            // Check p4 handle for 4-point fibs (disjoint channel)
            if (fib.p4) {
                const x4 = rs.timeToX(fib.p4.time);
                const y4 = rs.valueToY(fib.p4.price);
                if (isNearHandle(mx, my, x4, y4, HANDLE_HIT_RADIUS)) return 'p4';
            }
        }

        // Check if within plot bounds horizontally
        if (mx < plotLeft || mx > plotRight) return null;

        // Check if near the anchor trend line (diagonal from p1 to p2)
        const anchorDist = pointToLineDistance(mx, my, x1, y1, x2, y2);
        if (anchorDist <= HIT_TOLERANCE) return 'body';

        // Check if mouse is near any level line
        const priceRange = fib.p2.price - fib.p1.price;
        for (const level of fib.levels) {
            const levelPrice = fib.p1.price + priceRange * level.ratio;
            const levelY = rs.valueToY(levelPrice);

            // Check vertical distance to level
            if (Math.abs(my - levelY) <= HIT_TOLERANCE) {
                return 'body';
            }
        }

        // Also check if near the left edge where labels are (easier to click labels)
        const minY = Math.min(y1, y2);
        const maxY = Math.max(y1, y2);
        if (my >= minY - HIT_TOLERANCE && my <= maxY + HIT_TOLERANCE) {
            if (mx >= plotLeft && mx <= plotLeft + 150) {
                return 'body';
            }
        }

        return null;
    };

    const findFibAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { fib: DrawingFib; handle: HandleType } | null => {
        // Check selected fib first
        if (state.selectedFibId) {
            const selected = state.fibs.find(f => f.id === state.selectedFibId);
            if (selected) {
                const handle = hitTestFib(mx, my, selected, rs);
                if (handle) return { fib: selected, handle };
            }
        }

        // Check all fibs (reverse order = top first)
        for (let i = state.fibs.length - 1; i >= 0; i--) {
            const fib = state.fibs[i];
            const handle = hitTestFib(mx, my, fib, rs);
            if (handle) return { fib, handle };
        }

        return null;
    };

    // ========================================================================
    // Rectangle Hit Detection
    // ========================================================================

    type RectHandleType = 'p1' | 'p2' | 'p3' | 'p4' | 'body';

    const hitTestRect = (
        mx: number, my: number,
        rect: DrawingRect,
        rs: PluginRenderState
    ): RectHandleType | null => {
        const x1 = rs.timeToX(rect.p1.time);
        const y1 = rs.valueToY(rect.p1.price);
        const x2 = rs.timeToX(rect.p2.time);
        const y2 = rs.valueToY(rect.p2.price);

        const left = Math.min(x1, x2);
        const right = Math.max(x1, x2);
        const top = Math.min(y1, y2);
        const bottom = Math.max(y1, y2);

        // Check corner handles first (if selected)
        if (state.selectedRectId === rect.id) {
            // p1 = top-left, p2 = top-right, p3 = bottom-left, p4 = bottom-right
            if (isNearHandle(mx, my, left, top, HANDLE_HIT_RADIUS)) return 'p1';
            if (isNearHandle(mx, my, right, top, HANDLE_HIT_RADIUS)) return 'p2';
            if (isNearHandle(mx, my, left, bottom, HANDLE_HIT_RADIUS)) return 'p3';
            if (isNearHandle(mx, my, right, bottom, HANDLE_HIT_RADIUS)) return 'p4';
        }

        // Check body (inside rect or near edges)
        const insideX = mx >= left - HIT_TOLERANCE && mx <= right + HIT_TOLERANCE;
        const insideY = my >= top - HIT_TOLERANCE && my <= bottom + HIT_TOLERANCE;

        if (insideX && insideY) {
            // Near any edge?
            const nearLeft = Math.abs(mx - left) <= HIT_TOLERANCE;
            const nearRight = Math.abs(mx - right) <= HIT_TOLERANCE;
            const nearTop = Math.abs(my - top) <= HIT_TOLERANCE;
            const nearBottom = Math.abs(my - bottom) <= HIT_TOLERANCE;

            if (nearLeft || nearRight || nearTop || nearBottom) return 'body';

            // Or inside the filled area
            if (mx > left && mx < right && my > top && my < bottom) return 'body';
        }

        return null;
    };

    const findRectAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { rect: DrawingRect; handle: RectHandleType } | null => {
        // Check selected rect first (handle priority)
        if (state.selectedRectId) {
            const selected = state.rects.find(r => r.id === state.selectedRectId);
            if (selected) {
                const handle = hitTestRect(mx, my, selected, rs);
                if (handle) return { rect: selected, handle };
            }
        }

        // Check all rects (reverse order = top first)
        for (let i = state.rects.length - 1; i >= 0; i--) {
            const rect = state.rects[i];
            const handle = hitTestRect(mx, my, rect, rs);
            if (handle) return { rect, handle };
        }

        return null;
    };

    type EllipseHandleType = 'p1' | 'p2' | 'body';

    const hitTestEllipse = (
        mx: number, my: number,
        ellipse: DrawingEllipse,
        rs: PluginRenderState
    ): EllipseHandleType | null => {
        const x1 = rs.timeToX(ellipse.p1.time);
        const y1 = rs.valueToY(ellipse.p1.price);
        const x2 = rs.timeToX(ellipse.p2.time);
        const y2 = rs.valueToY(ellipse.p2.price);

        // Check handles first (if selected)
        if (state.selectedEllipseId === ellipse.id) {
            if (isNearHandle(mx, my, x1, y1, HANDLE_HIT_RADIUS)) return 'p1';
            if (isNearHandle(mx, my, x2, y2, HANDLE_HIT_RADIUS)) return 'p2';
        }

        // Calculate ellipse geometry
        let centerX: number, centerY: number, radiusX: number, radiusY: number;

        if (ellipse.type === 'circle') {
            centerX = x1;
            centerY = y1;
            const radius = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
            radiusX = radius;
            radiusY = radius;
        } else {
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);
            centerX = left + width / 2;
            centerY = top + height / 2;
            radiusX = width / 2;
            radiusY = height / 2;
        }

        if (radiusX < 1 || radiusY < 1) return null;

        // Check if point is inside ellipse using ellipse equation
        const normalizedX = (mx - centerX) / radiusX;
        const normalizedY = (my - centerY) / radiusY;
        const distance = normalizedX * normalizedX + normalizedY * normalizedY;

        // Inside or near edge
        if (distance <= 1.0 + HIT_TOLERANCE / Math.min(radiusX, radiusY)) {
            return 'body';
        }

        return null;
    };

    const findEllipseAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { ellipse: DrawingEllipse; handle: EllipseHandleType } | null => {
        // ... (existing implementation)
        // Check selected ellipse first (handle priority)
        if (state.selectedEllipseId) {
            const selected = state.ellipses.find(e => e.id === state.selectedEllipseId);
            if (selected) {
                const handle = hitTestEllipse(mx, my, selected, rs);
                if (handle) return { ellipse: selected, handle };
            }
        }

        // Check all ellipses (reverse order = top first)
        for (let i = state.ellipses.length - 1; i >= 0; i--) {
            const ellipse = state.ellipses[i];
            const handle = hitTestEllipse(mx, my, ellipse, rs);
            if (handle) return { ellipse, handle };
        }

        return null;
    };

    const dummyCanvas = document.createElement('canvas');
    const dummyCtx = dummyCanvas.getContext('2d');

    const getTextBounds = (text: DrawingText, rs: PluginRenderState) => {
        const x = rs.timeToX(text.position.time);
        const y = rs.valueToY(text.position.price);

        let width = 0;
        let height = 0;

        if (dummyCtx) {
            dummyCtx.font = `${text.fontSize}px sans-serif`;
            const metrics = dummyCtx.measureText(text.content);
            width = metrics.width + (text.padding * 2);
            height = text.fontSize + (text.padding * 2);
        } else {
            // Fallback approximation
            width = text.content.length * (text.fontSize * 0.6) + (text.padding * 2);
            height = text.fontSize + (text.padding * 2);
        }

        const left = x - width / 2;
        const top = y - height / 2;

        return { left, top, width, height };
    };

    const hitTestText = (
        mx: number, my: number,
        text: DrawingText,
        rs: PluginRenderState
    ): 'body' | null => {
        const { left, top, width, height } = getTextBounds(text, rs);

        if (mx >= left && mx <= left + width &&
            my >= top && my <= top + height) {
            return 'body';
        }

        return null;
    };

    const findTextAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { text: DrawingText; handle: 'body' } | null => {
        // Check selected first
        if (state.selectedTextId) {
            const selected = state.texts.find(t => t.id === state.selectedTextId);
            if (selected) {
                const handle = hitTestText(mx, my, selected, rs);
                if (handle) return { text: selected, handle };
            }
        }

        // Check all texts
        for (let i = state.texts.length - 1; i >= 0; i--) {
            const text = state.texts[i];
            const handle = hitTestText(mx, my, text, rs);
            if (handle) return { text, handle };
        }
        return null;
    };

    // Cross Hit Detection
    const hitTestCross = (
        mx: number, my: number,
        cross: DrawingCross,
        rs: PluginRenderState
    ): boolean => {
        const x = rs.timeToX(cross.time);
        const y = rs.valueToY(cross.price);

        // Check if near intersection point
        const distToCenter = Math.sqrt((mx - x) ** 2 + (my - y) ** 2);
        if (distToCenter <= HANDLE_HIT_RADIUS) return true;

        // Check if near horizontal line
        if (Math.abs(my - y) <= HIT_TOLERANCE) return true;

        // Check if near vertical line
        if (Math.abs(mx - x) <= HIT_TOLERANCE) return true;

        return false;
    };

    const findCrossAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): DrawingCross | null => {
        // Check selected cross first
        if (state.selectedCrossId) {
            const selected = state.crosses.find(c => c.id === state.selectedCrossId);
            if (selected && hitTestCross(mx, my, selected, rs)) {
                return selected;
            }
        }

        // Check all crosses (reverse order = top first)
        for (let i = state.crosses.length - 1; i >= 0; i--) {
            const cross = state.crosses[i];
            if (hitTestCross(mx, my, cross, rs)) {
                return cross;
            }
        }

        return null;
    };

    const findNoteAtPoint = (mx: number, my: number, rs: PluginRenderState): DrawingNote | null => {
        for (const note of state.notes) {
            const x = rs.timeToX(note.position.time);
            const y = rs.valueToY(note.position.price);

            // Check icon (20px radius)
            const iconDist = Math.sqrt(Math.pow(mx - x, 2) + Math.pow(my - y, 2));
            if (iconDist <= 15) return note;

            // Check text box if not minimized
            if (!note.minimized) {
                const boxX = x + 15;
                const boxY = y - 10;
                const boxWidth = 80; // Approximate
                const boxHeight = 20;
                if (mx >= boxX && mx <= boxX + boxWidth && my >= boxY && my <= boxY + boxHeight) {
                    return note;
                }
            }
        }
        return null;
    };

    const findCalloutAtPoint = (mx: number, my: number, rs: PluginRenderState): DrawingCallout | null => {
        for (const callout of state.callouts) {
            const textX = rs.timeToX(callout.textPosition.time);
            const textY = rs.valueToY(callout.textPosition.price);

            // Check text box (approximate 100x20)
            const boxWidth = 100;
            const boxHeight = 20;
            const boxX = textX - boxWidth / 2;
            const boxY = textY - boxHeight / 2;

            if (mx >= boxX && mx <= boxX + boxWidth && my >= boxY && my <= boxY + boxHeight) {
                return callout;
            }
        }
        return null;
    };

    const hitTestMarker = (
        mx: number, my: number,
        marker: DrawingMarker,
        rs: PluginRenderState
    ): 'body' | null => {
        const x = rs.snapX(rs.timeToX(marker.position.time));
        const y = rs.snapY(rs.valueToY(marker.position.price));
        // Approximate center y based on marker type (mostly above point)
        const centerY = y - marker.size / 2;

        const dist = Math.sqrt((mx - x) ** 2 + (my - centerY) ** 2);

        if (dist <= marker.size + HIT_TOLERANCE) {
            return 'body';
        }
        return null;
    };

    const findMarkerAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { marker: DrawingMarker; handle: 'body' } | null => {
        if (state.selectedMarkerId) {
            const selected = state.markers.find(m => m.id === state.selectedMarkerId);
            if (selected) {
                if (hitTestMarker(mx, my, selected, rs)) return { marker: selected, handle: 'body' };
            }
        }
        for (let i = state.markers.length - 1; i >= 0; i--) {
            const marker = state.markers[i];
            if (hitTestMarker(mx, my, marker, rs)) return { marker, handle: 'body' };
        }
        return null;
    };

    const hitTestMeasure = (
        mx: number, my: number,
        measure: DrawingMeasure,
        rs: PluginRenderState
    ): HandleType | null => {
        const x1 = rs.snapX(rs.timeToX(measure.p1.time));
        const y1 = rs.snapY(rs.valueToY(measure.p1.price));
        const x2 = rs.snapX(rs.timeToX(measure.p2.time));
        const y2 = rs.snapY(rs.valueToY(measure.p2.price));

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const right = left + width;
        const bottom = top + height;

        // Check resize handles (corners)
        const handles: { type: HandleType; x: number; y: number }[] = [
            { type: 'p1', x: left, y: top },       // TL - roughly p1
            { type: 'p2', x: right, y: bottom },   // BR - roughly p2
        ];

        // Simpler handle logic: just p1 and p2 for now, or corners?
        // Let's use bounding box hit test for body
        if (mx >= left && mx <= right && my >= top && my <= bottom) {
            // Check near corners
            const dist1 = Math.sqrt((mx - x1) ** 2 + (my - y1) ** 2);
            if (dist1 <= HIT_TOLERANCE) return 'p1';

            const dist2 = Math.sqrt((mx - x2) ** 2 + (my - y2) ** 2);
            if (dist2 <= HIT_TOLERANCE) return 'p2';

            return 'body';
        }

        return null;
    };

    const findMeasureAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { measure: DrawingMeasure; handle: HandleType } | null => {
        if (state.selectedMeasureId) {
            const selected = state.measures.find(m => m.id === state.selectedMeasureId);
            if (selected) {
                const handle = hitTestMeasure(mx, my, selected, rs);
                if (handle) return { measure: selected, handle };
            }
        }
        for (let i = state.measures.length - 1; i >= 0; i--) {
            const measure = state.measures[i];
            const handle = hitTestMeasure(mx, my, measure, rs);
            if (handle) return { measure, handle };
        }
        return null;
    };

    const hitTestGann = (
        mx: number, my: number,
        gann: DrawingGann,
        rs: PluginRenderState
    ): HandleType | null => {
        const x1 = rs.snapX(rs.timeToX(gann.p1.time));
        const y1 = rs.snapY(rs.valueToY(gann.p1.price));
        const x2 = rs.snapX(rs.timeToX(gann.p2.time));
        const y2 = rs.snapY(rs.valueToY(gann.p2.price));

        // Check handle points first
        const dist1 = Math.sqrt((mx - x1) ** 2 + (my - y1) ** 2);
        if (dist1 <= HANDLE_HIT_RADIUS) return 'p1';

        const dist2 = Math.sqrt((mx - x2) ** 2 + (my - y2) ** 2);
        if (dist2 <= HANDLE_HIT_RADIUS) return 'p2';

        // For Gann Fan: check if mouse is near any of the fan lines
        if (gann.type === 'gann_fan') {
            const dx = x2 - x1;
            const dy = y2 - y1;

            for (const angle of gann.angles) {
                // Calculate point on this angle line closest to mouse
                const angleDir = { x: dx, y: dy * angle.ratio };
                const len = Math.sqrt(angleDir.x ** 2 + angleDir.y ** 2);
                if (len < 0.001) continue;

                const dirX = angleDir.x / len;
                const dirY = angleDir.y / len;

                // Project mouse onto line
                const pmx = mx - x1;
                const pmy = my - y1;
                const t = pmx * dirX + pmy * dirY;

                if (t > 0) {
                    const projX = x1 + dirX * t;
                    const projY = y1 + dirY * t;
                    const dist = Math.sqrt((mx - projX) ** 2 + (my - projY) ** 2);
                    if (dist <= HIT_TOLERANCE) return 'body';
                }
            }
        }

        // For Gann Box: check bounding box
        if (gann.type === 'gann_box') {
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const right = Math.max(x1, x2);
            const bottom = Math.max(y1, y2);

            if (mx >= left && mx <= right && my >= top && my <= bottom) {
                return 'body';
            }
        }

        return null;
    };

    const findGannAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { gann: DrawingGann; handle: HandleType } | null => {
        if (state.selectedGannId) {
            const selected = state.ganns.find(g => g.id === state.selectedGannId);
            if (selected) {
                const handle = hitTestGann(mx, my, selected, rs);
                if (handle) return { gann: selected, handle };
            }
        }
        for (let i = state.ganns.length - 1; i >= 0; i--) {
            const gann = state.ganns[i];
            const handle = hitTestGann(mx, my, gann, rs);
            if (handle) return { gann, handle };
        }
        return null;
    };

    // Pattern hit testing - returns point index as string ('p0', 'p1', etc.) or 'body'
    const hitTestPattern = (
        mx: number, my: number,
        pattern: DrawingPattern,
        rs: PluginRenderState
    ): HandleType | string | null => {
        // Convert pattern points to screen coordinates
        const screenPoints = pattern.points.map(p => ({
            x: rs.snapX(rs.timeToX(p.time)),
            y: rs.snapY(rs.valueToY(p.price)),
        }));

        // Check each point handle
        for (let i = 0; i < screenPoints.length; i++) {
            const dist = Math.sqrt((mx - screenPoints[i].x) ** 2 + (my - screenPoints[i].y) ** 2);
            if (dist <= HANDLE_HIT_RADIUS) {
                return `p${i}`;  // Return point index
            }
        }

        // Check proximity to line segments between points
        for (let i = 1; i < screenPoints.length; i++) {
            const x1 = screenPoints[i - 1].x;
            const y1 = screenPoints[i - 1].y;
            const x2 = screenPoints[i].x;
            const y2 = screenPoints[i].y;

            const dist = pointToLineDistance(mx, my, x1, y1, x2, y2);
            if (dist <= HIT_TOLERANCE) {
                return 'body';
            }
        }

        return null;
    };

    const findPatternAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { pattern: DrawingPattern; handle: string } | null => {
        if (state.selectedPatternId) {
            const selected = state.patterns.find(p => p.id === state.selectedPatternId);
            if (selected) {
                const handle = hitTestPattern(mx, my, selected, rs);
                if (handle) return { pattern: selected, handle };
            }
        }
        for (let i = state.patterns.length - 1; i >= 0; i--) {
            const pattern = state.patterns[i];
            const handle = hitTestPattern(mx, my, pattern, rs);
            if (handle) return { pattern, handle };
        }
        return null;
    };

    // Position hit testing - check if point is within position bounding box or on lines
    const hitTestPosition = (
        mx: number, my: number,
        position: DrawingPosition,
        rs: PluginRenderState
    ): HandleType | null => {
        const entryY = rs.snapY(rs.valueToY(position.entryPrice));
        const targetY = rs.snapY(rs.valueToY(position.targetPrice));
        const stopY = rs.snapY(rs.valueToY(position.stopPrice));
        const startX = rs.snapX(rs.timeToX(position.startTime));
        const endX = rs.snapX(rs.timeToX(position.endTime));

        const left = Math.min(startX, endX);
        const right = Math.max(startX, endX);
        const top = Math.min(entryY, targetY, stopY);
        const bottom = Math.max(entryY, targetY, stopY);

        // Check corner handles for resizing
        if (Math.abs(mx - left) <= HANDLE_HIT_RADIUS && Math.abs(my - entryY) <= HANDLE_HIT_RADIUS) {
            return 'p1';  // Left side of entry line
        }
        if (Math.abs(mx - right) <= HANDLE_HIT_RADIUS && Math.abs(my - entryY) <= HANDLE_HIT_RADIUS) {
            return 'p2';  // Right side of entry line
        }

        // Check if within bounding box
        if (mx >= left && mx <= right && my >= top && my <= bottom) {
            return 'body';
        }

        return null;
    };

    const findPositionAtPoint = (
        mx: number, my: number,
        rs: PluginRenderState
    ): { position: DrawingPosition; handle: HandleType } | null => {
        if (state.selectedPositionId) {
            const selected = state.positions.find(p => p.id === state.selectedPositionId);
            if (selected) {
                const handle = hitTestPosition(mx, my, selected, rs);
                if (handle) return { position: selected, handle };
            }
        }
        for (let i = state.positions.length - 1; i >= 0; i--) {
            const position = state.positions[i];
            const handle = hitTestPosition(mx, my, position, rs);
            if (handle) return { position, handle };
        }
        return null;
    };

    // ========================================================================
    // Rendering
    // ========================================================================

    const renderLine = (ctx: CanvasRenderingContext2D, line: DrawingLine, rs: PluginRenderState) => {
        let { x1, y1, x2, y2 } = getLineScreenCoords(line, rs);
        const isSelected = state.selectedLineId === line.id;
        const isHovered = state.hoveredLineId === line.id;

        // Get canvas bounds for ray/extended line extension
        const canvasWidth = rs.plotWidth || 2000;
        const canvasHeight = rs.plotHeight || 1000;

        // Calculate extended coordinates for ray and extended line types
        let drawX1 = x1, drawY1 = y1, drawX2 = x2, drawY2 = y2;

        if (line.type === 'ray' || line.type === 'extended' || line.type === 'anchored_vwap') {
            const dx = x2 - x1;
            const dy = y2 - y1;

            if (Math.abs(dx) > 0.001 || Math.abs(dy) > 0.001) {
                // Extend line to canvas edges
                const extendToEdge = (startX: number, startY: number, dirX: number, dirY: number): { x: number; y: number } => {
                    let t = 10000; // Large multiplier
                    // Clamp to canvas boundaries
                    if (Math.abs(dirX) > 0.001) {
                        const tRight = (canvasWidth - startX) / dirX;
                        const tLeft = -startX / dirX;
                        const tX = dirX > 0 ? tRight : tLeft;
                        if (tX > 0) t = Math.min(t, tX);
                    }
                    if (Math.abs(dirY) > 0.001) {
                        const tBottom = (canvasHeight - startY) / dirY;
                        const tTop = -startY / dirY;
                        const tY = dirY > 0 ? tBottom : tTop;
                        if (tY > 0) t = Math.min(t, tY);
                    }
                    return { x: startX + dirX * t, y: startY + dirY * t };
                };

                // Ray / Anchored VWAP: extend from p1 through p2 to edge
                if (line.type === 'ray' || line.type === 'anchored_vwap') {
                    const extended = extendToEdge(x1, y1, dx, dy);
                    drawX2 = extended.x;
                    drawY2 = extended.y;
                }

                // Extended: extend both directions
                if (line.type === 'extended') {
                    const ext1 = extendToEdge(x1, y1, -dx, -dy);
                    const ext2 = extendToEdge(x1, y1, dx, dy);
                    drawX1 = ext1.x;
                    drawY1 = ext1.y;
                    drawX2 = ext2.x;
                    drawY2 = ext2.y;
                }
            }
        }

        // Draw line
        ctx.strokeStyle = line.color;
        ctx.lineWidth = isSelected ? line.width + 1 : line.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (line.dash && line.dash.length > 0) {
            ctx.setLineDash(line.dash);
        } else {
            ctx.setLineDash([]);
        }

        // Hover glow effect
        if (isHovered && !isSelected) {
            ctx.save();
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.3)';
            ctx.lineWidth = line.width + 6;
            ctx.beginPath();
            ctx.moveTo(rs.snapX(drawX1), rs.snapY(drawY1));
            ctx.lineTo(rs.snapX(drawX2), rs.snapY(drawY2));
            ctx.stroke();
            ctx.restore();
        }

        ctx.beginPath();
        ctx.moveTo(rs.snapX(drawX1), rs.snapY(drawY1));
        ctx.lineTo(rs.snapX(drawX2), rs.snapY(drawY2));
        ctx.stroke();

        // Draw arrowhead for arrow type
        if (line.type === 'arrow') {
            const arrowSize = 12;
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const arrowAngle = Math.PI / 6; // 30 degrees

            ctx.beginPath();
            ctx.moveTo(rs.snapX(x2), rs.snapY(y2));
            ctx.lineTo(
                rs.snapX(x2 - arrowSize * Math.cos(angle - arrowAngle)),
                rs.snapY(y2 - arrowSize * Math.sin(angle - arrowAngle))
            );
            ctx.moveTo(rs.snapX(x2), rs.snapY(y2));
            ctx.lineTo(
                rs.snapX(x2 - arrowSize * Math.cos(angle + arrowAngle)),
                rs.snapY(y2 - arrowSize * Math.sin(angle + arrowAngle))
            );
            ctx.stroke();
        }

        ctx.setLineDash([]);

        // Price label for horizontal lines
        if (line.type === 'horizontal' && line.showLabel) {
            const price = line.p1.price;
            const labelText = line.labelText || price.toFixed(2);
            const plotRight = rs.plotRect.x + rs.plotRect.width;
            const labelY = rs.valueToY(price);

            // Measure text
            ctx.font = '11px sans-serif';
            const metrics = ctx.measureText(labelText);
            const padding = 4;
            const badgeWidth = metrics.width + padding * 2;
            const badgeHeight = 18;
            const labelX = plotRight + 2;

            // Background badge
            ctx.fillStyle = line.color;
            ctx.fillRect(labelX, labelY - badgeHeight / 2, badgeWidth, badgeHeight);

            // Text
            ctx.fillStyle = '#ffffff';
            ctx.textBaseline = 'middle';
            ctx.fillText(labelText, labelX + padding, labelY);
        }

        // Trend Angle: show angle for non-horizontal/vertical lines
        if (line.type === 'line' || line.type === 'ray' || line.type === 'extended') {
            const angle = Math.atan2(y2 - y1, x2 - x1) * (180 / Math.PI);
            const displayAngle = Math.abs(angle) > 90 ? 180 - Math.abs(angle) : Math.abs(angle);

            // Show angle near P1
            ctx.font = '10px sans-serif';
            ctx.fillStyle = line.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.fillText(`${displayAngle.toFixed(1)}°`, x1, y1 - 8);
        }

        // Info Line: show statistics for regular lines
        if (line.type === 'line' && isSelected) {
            const priceChange = line.p2.price - line.p1.price;
            const percentChange = (priceChange / line.p1.price) * 100;
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;

            // Info box
            const info = `Δ${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)} (${percentChange >= 0 ? '+' : ''}${percentChange.toFixed(2)}%)`;
            ctx.font = '10px sans-serif';
            const metrics = ctx.measureText(info);
            const boxPadding = 4;
            const boxWidth = metrics.width + boxPadding * 2;
            const boxHeight = 16;

            // Background
            ctx.fillStyle = 'rgba(0, 0, 0, 0.7)';
            ctx.fillRect(midX - boxWidth / 2, midY - boxHeight - 10, boxWidth, boxHeight);

            // Text
            ctx.fillStyle = priceChange >= 0 ? '#26a69a' : '#ef5350';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(info, midX, midY - 10);
        }

        // Selection handles (at original p1/p2, not extended)
        if (isSelected) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = line.color;
            ctx.lineWidth = 2;

            // Handle 1
            ctx.beginPath();
            ctx.arc(rs.snapX(x1), rs.snapY(y1), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Handle 2 (not for horizontal/vertical)
            if (line.type !== 'horizontal' && line.type !== 'vertical') {
                ctx.beginPath();
                ctx.arc(rs.snapX(x2), rs.snapY(y2), HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        // Time Price: show price/time ratio
        if (line.showRatio) {
            const priceChange = Math.abs(line.p2.price - line.p1.price);
            const timeChange = Math.abs(line.p2.time - line.p1.time);
            const ratio = timeChange > 0 ? (priceChange / (timeChange / 86400000)).toFixed(4) : '0';
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2;

            ctx.save();
            ctx.font = '11px sans-serif';
            ctx.fillStyle = line.color;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(`Ratio: ${ratio}/day`, midX, midY + 15);
            ctx.restore();
        }
    };

    // Render a rectangle
    const renderRect = (ctx: CanvasRenderingContext2D, rect: DrawingRect, rs: PluginRenderState) => {
        const x1 = rs.snapX(rs.timeToX(rect.p1.time));
        const y1 = rs.snapY(rs.valueToY(rect.p1.price));
        const x2 = rs.snapX(rs.timeToX(rect.p2.time));
        const y2 = rs.snapY(rs.valueToY(rect.p2.price));

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const centerX = left + width / 2;
        const centerY = top + height / 2;

        const isSelected = state.selectedRectId === rect.id;
        const isHovered = state.hoveredRectId === rect.id;

        // Apply rotation if present
        if (rect.rotation) {
            ctx.save();
            ctx.translate(centerX, centerY);
            ctx.rotate((rect.rotation * Math.PI) / 180);
            ctx.translate(-centerX, -centerY);
        }

        // Fill
        if (rect.fillOpacity > 0) {
            ctx.globalAlpha = rect.fillOpacity;
            ctx.fillStyle = rect.fillColor;
            ctx.fillRect(left, top, width, height);
            ctx.globalAlpha = 1;
        }

        // Hover glow effect
        if (isHovered && !isSelected) {
            ctx.save();
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.4)';
            ctx.lineWidth = rect.strokeWidth + 4;
            ctx.strokeRect(left, top, width, height);
            ctx.restore();
        }

        // Stroke
        ctx.strokeStyle = rect.strokeColor;
        ctx.lineWidth = isSelected ? rect.strokeWidth + 1 : rect.strokeWidth;
        ctx.strokeRect(left, top, width, height);

        // Selection handles (4 corners)
        if (isSelected) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = rect.strokeColor;
            ctx.lineWidth = 2;

            const corners = [
                { x: left, y: top },
                { x: left + width, y: top },
                { x: left, y: top + height },
                { x: left + width, y: top + height },
            ];

            for (const corner of corners) {
                ctx.beginPath();
                ctx.arc(corner.x, corner.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }

        // Render zone label if present
        if (rect.label) {
            const padding = 4;
            ctx.font = 'bold 11px -apple-system, BlinkMacSystemFont, sans-serif';
            const textWidth = ctx.measureText(rect.label).width;

            // Position based on labelPosition
            let labelX = left + padding;
            let labelY = top + padding + 11;

            if (rect.labelPosition === 'top-right') {
                labelX = left + width - textWidth - padding;
            } else if (rect.labelPosition === 'bottom-left') {
                labelY = top + height - padding;
            } else if (rect.labelPosition === 'bottom-right') {
                labelX = left + width - textWidth - padding;
                labelY = top + height - padding;
            } else if (rect.labelPosition === 'center') {
                labelX = left + (width - textWidth) / 2;
                labelY = top + (height + 11) / 2;
            }

            // Background for readability
            ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
            ctx.fillRect(labelX - 2, labelY - 11, textWidth + 4, 14);

            // Text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(rect.label, labelX, labelY);
        }

        // Rotation handle (green circle above rectangle when selected)
        if (isSelected && rect.rotation !== undefined) {
            const handleX = centerX;
            const handleY = top - 20;
            ctx.fillStyle = '#4CAF50';
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(handleX, handleY, 6, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Restore context if rotated
        if (rect.rotation) {
            ctx.restore();
        }
    };

    // Render an ellipse or circle
    const renderEllipse = (ctx: CanvasRenderingContext2D, ellipse: DrawingEllipse, rs: PluginRenderState) => {
        const x1 = rs.snapX(rs.timeToX(ellipse.p1.time));
        const y1 = rs.snapY(rs.valueToY(ellipse.p1.price));
        const x2 = rs.snapX(rs.timeToX(ellipse.p2.time));
        const y2 = rs.snapY(rs.valueToY(ellipse.p2.price));

        const isSelected = state.selectedEllipseId === ellipse.id;
        const isHovered = state.hoveredEllipseId === ellipse.id;

        let centerX: number, centerY: number, radiusX: number, radiusY: number;

        if (ellipse.type === 'circle') {
            // Circle: p1 is center, p2 defines radius
            centerX = x1;
            centerY = y1;
            const radius = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
            radiusX = radius;
            radiusY = radius;
        } else {
            // Ellipse: p1 and p2 define bounding box
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);
            centerX = left + width / 2;
            centerY = top + height / 2;
            radiusX = width / 2;
            radiusY = height / 2;
        }

        // Skip if too small
        if (radiusX < 1 || radiusY < 1) return;

        // Fill
        if (ellipse.fillOpacity > 0) {
            ctx.globalAlpha = ellipse.fillOpacity;
            ctx.fillStyle = ellipse.fillColor;
            ctx.beginPath();
            ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // Hover glow effect
        if (isHovered && !isSelected) {
            ctx.save();
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.4)';
            ctx.lineWidth = ellipse.strokeWidth + 4;
            ctx.beginPath();
            ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Stroke
        ctx.strokeStyle = ellipse.strokeColor;
        ctx.lineWidth = isSelected ? ellipse.strokeWidth + 1 : ellipse.strokeWidth;
        ctx.beginPath();
        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
        ctx.stroke();

        // Selection handles
        if (isSelected) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = ellipse.strokeColor;
            ctx.lineWidth = 2;

            // Handle at p1 and p2
            ctx.beginPath();
            ctx.arc(x1, y1, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x2, y2, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    }


    // Render text annotation
    const renderText = (ctx: CanvasRenderingContext2D, text: DrawingText, rs: PluginRenderState) => {
        const x = rs.snapX(rs.timeToX(text.position.time));
        const y = rs.snapY(rs.valueToY(text.position.price));

        const isSelected = state.selectedTextId === text.id;
        const isHovered = state.hoveredTextId === text.id;

        ctx.font = `${text.fontSize}px sans-serif`;
        ctx.textBaseline = 'middle';
        const metrics = ctx.measureText(text.content);
        const width = metrics.width + (text.padding * 2);
        const height = text.fontSize + (text.padding * 2);

        // Center on point by default
        const left = x - width / 2;
        const top = y - height / 2;

        // Background
        if (text.backgroundOpacity > 0) {
            ctx.globalAlpha = text.backgroundOpacity;
            ctx.fillStyle = text.backgroundColor;
            ctx.fillRect(left, top, width, height);
            ctx.globalAlpha = 1;
        }

        // Hover effect
        if (isHovered && !isSelected) {
            ctx.save();
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.4)';
            ctx.lineWidth = 2;
            ctx.strokeRect(left - 2, top - 2, width + 4, height + 4);
            ctx.restore();
        }

        // Text content
        ctx.fillStyle = text.fontColor;
        ctx.fillText(text.content, left + text.padding, y);

        // Selection box
        if (isSelected) {
            ctx.strokeStyle = '#2b5278';
            ctx.lineWidth = 1;
            ctx.strokeRect(left, top, width, height);

            // Handle (for moving) - draw slightly offset or at corners? 
            // For now, just a border is enough to show selection, but let's add corner handles
            const corners = [
                { x: left, y: top },
                { x: left + width, y: top },
                { x: left + width, y: top + height },
                { x: left, y: top + height },
            ];

            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#2b5278';
            ctx.lineWidth = 2;

            for (const corner of corners) {
                ctx.beginPath();
                ctx.arc(corner.x, corner.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
    };

    const renderCross = (ctx: CanvasRenderingContext2D, cross: DrawingCross, rs: PluginRenderState) => {
        const x = rs.timeToX(cross.time);
        const y = rs.valueToY(cross.price);
        const plotLeft = rs.plotRect.x;
        const plotRight = rs.plotRect.x + rs.plotRect.width;
        const plotTop = rs.plotRect.y;
        const plotBottom = rs.plotRect.y + rs.plotRect.height;

        const isSelected = state.selectedCrossId === cross.id;
        const isHovered = state.hoveredCrossId === cross.id;

        // Draw horizontal line
        ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : cross.color;
        ctx.lineWidth = cross.width;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(plotLeft, y);
        ctx.lineTo(plotRight, y);
        ctx.stroke();

        // Draw vertical line
        ctx.beginPath();
        ctx.moveTo(x, plotTop);
        ctx.lineTo(x, plotBottom);
        ctx.stroke();

        // Draw intersection handle if selected
        if (isSelected) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = '#2962ff';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    };

    const renderNote = (ctx: CanvasRenderingContext2D, note: DrawingNote, rs: PluginRenderState) => {
        const x = rs.timeToX(note.position.time);
        const y = rs.valueToY(note.position.price);

        // Note icon (always visible)
        ctx.font = '20px sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.fillText(note.icon, x, y);

        // Text box (if not minimized)
        if (!note.minimized) {
            ctx.font = `${note.fontSize}px sans-serif`;
            const metrics = ctx.measureText(note.text);
            const padding = 8;
            const boxWidth = metrics.width + padding * 2;
            const boxHeight = note.fontSize + padding * 2;
            const boxX = x + 15;
            const boxY = y - boxHeight / 2;

            // Background
            ctx.fillStyle = note.backgroundColor;
            ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

            // Text
            ctx.textAlign = 'left';
            ctx.fillStyle = note.color;
            ctx.fillText(note.text, boxX + padding, y);
        }
    };

    const renderCallout = (ctx: CanvasRenderingContext2D, callout: DrawingCallout, rs: PluginRenderState) => {
        const textX = rs.timeToX(callout.textPosition.time);
        const textY = rs.valueToY(callout.textPosition.price);
        const targetX = rs.timeToX(callout.targetPosition.time);
        const targetY = rs.valueToY(callout.targetPosition.price);

        // Arrow line to target
        ctx.strokeStyle = callout.arrowColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 2]);
        ctx.beginPath();
        ctx.moveTo(textX, textY);
        ctx.lineTo(targetX, targetY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrow head at target
        const angle = Math.atan2(targetY - textY, targetX - textX);
        const arrowSize = 8;
        ctx.fillStyle = callout.arrowColor;
        ctx.beginPath();
        ctx.moveTo(targetX, targetY);
        ctx.lineTo(
            targetX - arrowSize * Math.cos(angle - Math.PI / 6),
            targetY - arrowSize * Math.sin(angle - Math.PI / 6)
        );
        ctx.lineTo(
            targetX - arrowSize * Math.cos(angle + Math.PI / 6),
            targetY - arrowSize * Math.sin(angle + Math.PI / 6)
        );
        ctx.closePath();
        ctx.fill();

        // Text box at text position
        ctx.font = `${callout.fontSize}px sans-serif`;
        const metrics = ctx.measureText(callout.text);
        const padding = 8;
        const boxWidth = metrics.width + padding * 2;
        const boxHeight = callout.fontSize + padding * 2;
        const boxX = textX - boxWidth / 2;
        const boxY = textY - boxHeight / 2;

        // Background
        ctx.fillStyle = callout.backgroundColor;
        ctx.fillRect(boxX, boxY, boxWidth, boxHeight);

        // Text
        ctx.fillStyle = callout.fontColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(callout.text, textX, textY);
    };

    // Render marker/icon
    const renderMarker = (ctx: CanvasRenderingContext2D, marker: DrawingMarker, rs: PluginRenderState) => {
        const x = rs.snapX(rs.timeToX(marker.position.time));
        const y = rs.snapY(rs.valueToY(marker.position.price));

        const isSelected = state.selectedMarkerId === marker.id;
        const isHovered = state.hoveredMarkerId === marker.id;

        const size = marker.size;

        ctx.fillStyle = marker.color;
        ctx.strokeStyle = '#2b5278';
        ctx.lineWidth = 1;

        ctx.beginPath();
        if (marker.type === 'arrow_up') {
            ctx.moveTo(x, y - size / 2);
            ctx.lineTo(x - size / 2, y + size / 2);
            ctx.lineTo(x + size / 2, y + size / 2);
            ctx.closePath();
        } else if (marker.type === 'arrow_down') {
            ctx.moveTo(x, y + size / 2);
            ctx.lineTo(x - size / 2, y - size / 2);
            ctx.lineTo(x + size / 2, y - size / 2);
            ctx.closePath();
        } else if (marker.type === 'arrow_left') {
            ctx.moveTo(x - size / 2, y);
            ctx.lineTo(x + size / 2, y - size / 2);
            ctx.lineTo(x + size / 2, y + size / 2);
            ctx.closePath();
        } else if (marker.type === 'arrow_right') {
            ctx.moveTo(x + size / 2, y);
            ctx.lineTo(x - size / 2, y - size / 2);
            ctx.lineTo(x - size / 2, y + size / 2);
            ctx.closePath();
        } else if (marker.type === 'flag') {
            // Simple flag
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - size);
            ctx.lineTo(x + size / 1.5, y - size + size / 4);
            ctx.lineTo(x, y - size / 2);
            ctx.stroke(); // Flag pole
            // Flag content
            ctx.moveTo(x, y - size);
            ctx.lineTo(x + size / 1.5, y - size + size / 4);
            ctx.lineTo(x, y - size / 2);
            ctx.closePath();
        } else if (marker.type === 'pin') {
            ctx.arc(x, y - size / 2, size / 3, 0, Math.PI * 2);
            ctx.moveTo(x, y);
            ctx.lineTo(x, y - size / 2);
            ctx.stroke();
            ctx.beginPath();
            ctx.arc(x, y - size / 2, size / 3, 0, Math.PI * 2);
            ctx.closePath();
        } else if (marker.type === 'swing_high') {
            // Triangle pointing up + Label
            ctx.moveTo(x, y - size / 2);
            ctx.lineTo(x - size / 2, y + size / 2);
            ctx.lineTo(x + size / 2, y + size / 2);
            ctx.closePath();
        } else if (marker.type === 'swing_low') {
            // Triangle pointing down + Label
            ctx.moveTo(x, y + size / 2);
            ctx.lineTo(x - size / 2, y - size / 2);
            ctx.lineTo(x + size / 2, y - size / 2);
            ctx.closePath();
        } else if (marker.type === 'bos' || marker.type === 'choch' || marker.type === 'invalidation') {
            // Badge style
            const text = marker.label || (marker.type === 'bos' ? 'BOS' : marker.type === 'choch' ? 'CHoCH' : 'INV');
            ctx.font = 'bold 10px sans-serif';
            const width = ctx.measureText(text).width + 8;
            const height = 14;
            ctx.roundRect(x - width / 2, y - height / 2, width, height, 4);
            ctx.fill();
            ctx.stroke();

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(text, x, y);
            return; // Early return as we already filled/stroked
        } else if (marker.type === 'liquidity') {
            // Droplet shape
            ctx.moveTo(x, y - size / 2);
            ctx.bezierCurveTo(x + size / 2, y, x + size / 2, y + size / 2, x, y + size / 2);
            ctx.bezierCurveTo(x - size / 2, y + size / 2, x - size / 2, y, x, y - size / 2);
            ctx.closePath();
        } else {
            // Fallback
            ctx.arc(x, y, size / 2, 0, Math.PI * 2);
            ctx.closePath();
        }

        ctx.fill();
        ctx.stroke();

        // Render label for swing points if present
        if ((marker.type === 'swing_high' || marker.type === 'swing_low') && marker.label) {
            ctx.fillStyle = marker.color;
            ctx.font = 'bold 11px sans-serif';
            ctx.textAlign = 'center';

            const labelY = marker.type === 'swing_high'
                ? y - size / 2 - 4
                : y + size / 2 + 12;

            ctx.fillText(marker.label, x, labelY);
        }

        if (isSelected || isHovered) {
            ctx.strokeStyle = isSelected ? '#2b5278' : 'rgba(252, 116, 50, 0.4)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.arc(x, y - size / 2, size, 0, Math.PI * 2);
            ctx.stroke();
        }
    };

    // Render Measurement Tools
    const renderMeasure = (ctx: CanvasRenderingContext2D, measure: DrawingMeasure, rs: PluginRenderState) => {
        const x1 = rs.snapX(rs.timeToX(measure.p1.time));
        const y1 = rs.snapY(rs.valueToY(measure.p1.price));
        const x2 = rs.snapX(rs.timeToX(measure.p2.time));
        const y2 = rs.snapY(rs.valueToY(measure.p2.price));

        const left = Math.min(x1, x2);
        const top = Math.min(y1, y2);
        const width = Math.abs(x2 - x1);
        const height = Math.abs(y2 - y1);
        const right = left + width;
        const bottom = top + height;

        const isSelected = state.selectedMeasureId === measure.id;
        const isHovered = state.hoveredMeasureId === measure.id;

        // Calculate metrics
        const priceDiff = measure.p2.price - measure.p1.price;
        const percentChange = (priceDiff / measure.p1.price) * 100;
        const timeDiff = measure.p2.time - measure.p1.time;
        // Approximation: time diff / candle interval (assuming 1D for now, ideally needs interval from chart)
        // For now, just show time duration
        const days = Math.floor(Math.abs(timeDiff) / (24 * 60 * 60 * 1000));

        ctx.font = '12px sans-serif';
        ctx.textBaseline = 'middle';

        // Draw based on type
        if (measure.type === 'price_range') {
            // Vertical bar
            const x = (x1 + x2) / 2;
            ctx.fillStyle = measure.backgroundColor;
            ctx.globalAlpha = measure.backgroundOpacity;
            ctx.fillRect(x - 20, top, 40, height);
            ctx.globalAlpha = 1;

            ctx.strokeStyle = measure.color;
            ctx.lineWidth = measure.strokeWidth;
            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            // arrowheads
            ctx.moveTo(x - 4, top + 4); ctx.lineTo(x, top); ctx.lineTo(x + 4, top + 4);
            ctx.moveTo(x - 4, bottom - 4); ctx.lineTo(x, bottom); ctx.lineTo(x + 4, bottom - 4);
            ctx.stroke();

            // Label
            const label = `${priceDiff.toFixed(2)} (${percentChange.toFixed(2)}%)`;
            const metrics = ctx.measureText(label);
            const labelWidth = metrics.width + 10;
            const labelHeight = 20;

            ctx.fillStyle = '#1e222d';
            ctx.fillRect(x - labelWidth / 2, (top + bottom) / 2 - labelHeight / 2, labelWidth, labelHeight);
            ctx.fillStyle = measure.color;
            ctx.fillText(label, x - labelWidth / 2 + 5, (top + bottom) / 2);

        } else if (measure.type === 'date_range') {
            // Horizontal bar
            const y = (y1 + y2) / 2;
            ctx.fillStyle = measure.backgroundColor;
            ctx.globalAlpha = measure.backgroundOpacity;
            ctx.fillRect(left, y - 10, width, 20);
            ctx.globalAlpha = 1;

            ctx.strokeStyle = measure.color;
            ctx.lineWidth = measure.strokeWidth;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            // arrowheads
            ctx.moveTo(left + 4, y - 4); ctx.lineTo(left, y); ctx.lineTo(left + 4, y + 4);
            ctx.moveTo(right - 4, y - 4); ctx.lineTo(right, y); ctx.lineTo(right - 4, y + 4);
            ctx.stroke();

            // Label
            const label = `${days}d`;
            const metrics = ctx.measureText(label);
            const labelWidth = metrics.width + 10;
            const labelHeight = 20;

            ctx.fillStyle = '#1e222d';
            ctx.fillRect((left + right) / 2 - labelWidth / 2, y - labelHeight / 2, labelWidth, labelHeight);
            ctx.fillStyle = measure.color;
            ctx.fillText(label, (left + right) / 2 - labelWidth / 2 + 5, y);

        } else {
            // combined_range / quick_measure / fixed_range_volume_profile (Box)
            ctx.fillStyle = measure.backgroundColor;
            ctx.globalAlpha = measure.backgroundOpacity;
            ctx.fillRect(left, top, width, height);
            ctx.globalAlpha = 1;

            ctx.strokeStyle = measure.color;
            ctx.lineWidth = measure.strokeWidth;
            ctx.strokeRect(left, top, width, height);

            if (measure.type === 'fixed_range_volume_profile') {
                const histogramWidth = width * 0.4;
                const barHeight = height / 10;

                ctx.globalAlpha = 0.3;
                ctx.fillStyle = measure.color;

                // NEW-CH-002: Draw deterministic placeholder volume profile bars
                for (let i = 0; i < 10; i++) {
                    const barW = ((i * 7 + 3) % 10 / 10) * histogramWidth;
                    const barY = top + i * barHeight;
                    ctx.fillRect(left + width - barW, barY, barW, barHeight - 1);
                }

                // POC line
                const pocY = top + height * 0.4;
                ctx.strokeStyle = '#ef5350';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(left, pocY);
                ctx.lineTo(left + width, pocY);
                ctx.stroke();

                ctx.fillStyle = '#ef5350';
                ctx.font = '10px sans-serif';
                ctx.textAlign = 'right';
                ctx.fillText('POC', left + width - 2, pocY - 2);

                ctx.globalAlpha = 1.0;
            } else if (measure.type === 'combined_range') {
                // Draw combined labels overlay
                const centerX = left + width / 2;
                const centerY = top + height / 2;

                const timeDiff = Math.abs(measure.p2.time - measure.p1.time);
                const priceDiff = Math.abs(measure.p2.price - measure.p1.price);
                const bars = Math.round(timeDiff / (1000 * 60 * 60)); // Rough hours count

                const label = `${bars} bars, ${(timeDiff / (1000 * 60 * 60 * 24)).toFixed(1)}d\n${priceDiff.toFixed(2)} (${((priceDiff / measure.p1.price) * 100).toFixed(2)}%)`;

                ctx.font = '12px -apple-system, BlinkMacSystemFont, sans-serif';
                ctx.fillStyle = measure.color;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'middle';

                const lines = label.split('\n');
                lines.forEach((l, i) => {
                    ctx.fillText(l, centerX, centerY + (i - 0.5) * 16);
                });
            } else {
                // Draw Price/Date labels on edges (existing logic placeholder)
                // Center Label
                const labelPrice = `${priceDiff.toFixed(2)} (${percentChange.toFixed(2)}%)`;
                const labelTime = `${days}d`;
                const metricsP = ctx.measureText(labelPrice);
                const metricsT = ctx.measureText(labelTime);
                const labelWidth = Math.max(metricsP.width, metricsT.width) + 10;
                const labelHeight = 36;

                const cx = (left + right) / 2;
                const cy = (top + bottom) / 2;

                ctx.fillStyle = 'rgba(30, 34, 45, 0.8)';
                ctx.fillRect(cx - labelWidth / 2, cy - labelHeight / 2, labelWidth, labelHeight);

                ctx.fillStyle = '#ffffff';
                ctx.textAlign = 'center';
                ctx.fillText(labelPrice, cx, cy - 8);
                ctx.fillText(labelTime, cx, cy + 8);
                ctx.textAlign = 'left'; // reset
            }
        }

        // Selection handles
        if (isSelected || isHovered) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = measure.color;
            ctx.lineWidth = 1;

            // Draw corner handles
            [
                { x: left, y: top }, { x: right, y: top },
                { x: right, y: bottom }, { x: left, y: bottom }
            ].forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            });
        }
    };

    // Render VWAP Bands (VWAP line with standard deviation bands)
    const renderVWAPBands = (ctx: CanvasRenderingContext2D, vwapBands: DrawingVWAPBands, rs: PluginRenderState) => {
        const anchorX = rs.snapX(rs.timeToX(vwapBands.anchor.time));
        const anchorY = rs.snapY(rs.valueToY(vwapBands.anchor.price));

        const chartWidth = rs.plotRect.width;
        const rightEdge = rs.plotRect.x + chartWidth;

        // Simplified: use anchor price as VWAP baseline
        const vwapY = anchorY;

        // Simulate SD bands (typical VWAP SD ~0.5-2% of price)
        const priceRange = Math.abs(vwapBands.anchor.price * 0.015);
        const sd1 = rs.snapY(rs.valueToY(vwapBands.anchor.price + priceRange)) - vwapY;
        const sd2 = sd1 * 2;
        const sd3 = sd1 * 3;

        // Draw filled zones
        ctx.globalAlpha = vwapBands.fillOpacity;
        if (vwapBands.showBands[2]) {
            ctx.fillStyle = vwapBands.bandColors[2] || '#9c27b0';
            ctx.fillRect(anchorX, vwapY - sd3, rightEdge - anchorX, sd3 * 2);
        }
        if (vwapBands.showBands[1]) {
            ctx.fillStyle = vwapBands.bandColors[1] || '#ff9800';
            ctx.fillRect(anchorX, vwapY - sd2, rightEdge - anchorX, sd2 * 2);
        }
        if (vwapBands.showBands[0]) {
            ctx.fillStyle = vwapBands.bandColors[0] || '#2196f3';
            ctx.fillRect(anchorX, vwapY - sd1, rightEdge - anchorX, sd1 * 2);
        }
        ctx.globalAlpha = 1;

        // Draw SD band lines
        const bands = [
            { offset: sd1, label: '+1σ', show: vwapBands.showBands[0], color: vwapBands.bandColors[0] },
            { offset: -sd1, label: '-1σ', show: vwapBands.showBands[0], color: vwapBands.bandColors[0] },
            { offset: sd2, label: '+2σ', show: vwapBands.showBands[1], color: vwapBands.bandColors[1] },
            { offset: -sd2, label: '-2σ', show: vwapBands.showBands[1], color: vwapBands.bandColors[1] },
            { offset: sd3, label: '+3σ', show: vwapBands.showBands[2], color: vwapBands.bandColors[2] },
            { offset: -sd3, label: '-3σ', show: vwapBands.showBands[2], color: vwapBands.bandColors[2] },
        ];

        ctx.setLineDash([3, 3]);
        for (const band of bands) {
            if (!band.show) continue;
            const y = vwapY + band.offset;
            ctx.strokeStyle = band.color || vwapBands.vwapColor;
            ctx.lineWidth = vwapBands.strokeWidth * 0.8;
            ctx.globalAlpha = 0.6;
            ctx.beginPath();
            ctx.moveTo(anchorX, y);
            ctx.lineTo(rightEdge, y);
            ctx.stroke();
            if (vwapBands.showLabels) {
                ctx.font = '10px sans-serif';
                ctx.fillStyle = band.color;
                ctx.globalAlpha = 1;
                ctx.fillText(band.label, rightEdge - 30, y - 3);
            }
        }
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;

        // Main VWAP line
        ctx.strokeStyle = vwapBands.vwapColor;
        ctx.lineWidth = vwapBands.strokeWidth * 1.5;
        ctx.beginPath();
        ctx.moveTo(anchorX, vwapY);
        ctx.lineTo(rightEdge, vwapY);
        ctx.stroke();

        if (vwapBands.showLabels) {
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = vwapBands.vwapColor;
            ctx.fillText('VWAP', rightEdge - 40, vwapY - 8);
        }

        // Anchor point
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = vwapBands.vwapColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(anchorX, anchorY, HANDLE_RADIUS + 1, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
    };

    // Render Gann Tool (Fan or Box) - Enhanced Implementation
    const renderGann = (ctx: CanvasRenderingContext2D, gann: DrawingGann, rs: PluginRenderState) => {
        const x1 = rs.snapX(rs.timeToX(gann.p1.time));
        const y1 = rs.snapY(rs.valueToY(gann.p1.price));
        const x2 = rs.snapX(rs.timeToX(gann.p2.time));
        const y2 = rs.snapY(rs.valueToY(gann.p2.price));

        const isSelected = state.selectedGannId === gann.id;
        const isHovered = state.hoveredGannId === gann.id;

        // Calculate the scale from p1 to p2 (this defines "1x1" angle)
        const dx = x2 - x1;
        const dy = y2 - y1;

        // Get canvas bounds for line extension
        const canvasWidth = rs.plotRect.x + rs.plotRect.width;
        const canvasHeight = rs.plotRect.y + rs.plotRect.height;

        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (gann.type === 'gann_fan') {
            // === GANN FAN: 9 angle-based rays ===

            for (const angle of gann.angles) {
                // Calculate direction based on angle ratio
                // ratio = price_units / time_units
                // For 1x1: ratio = 1, meaning 1 price unit per 1 time unit
                const angleDir = {
                    x: dx,  // Time direction (same as p1->p2)
                    y: dy * angle.ratio  // Price direction scaled by ratio
                };

                // Normalize and extend to canvas edge
                const length = Math.sqrt(angleDir.x * angleDir.x + angleDir.y * angleDir.y);
                if (length < 0.001) continue;

                const dirX = angleDir.x / length;
                const dirY = angleDir.y / length;

                // Calculate how far to extend
                let t = 10000;
                if (Math.abs(dirX) > 0.001) {
                    const tRight = (canvasWidth - x1) / dirX;
                    const tLeft = -x1 / dirX;
                    t = Math.min(t, dirX > 0 ? tRight : -tLeft);
                }
                if (Math.abs(dirY) > 0.001) {
                    const tBottom = (canvasHeight - y1) / dirY;
                    const tTop = -y1 / dirY;
                    t = Math.min(t, dirY > 0 ? tBottom : -tTop);
                }

                const endX = x1 + dirX * Math.abs(t) * length;
                const endY = y1 + dirY * Math.abs(t) * length;

                // Highlight 1x1 angle with thicker line
                const is1x1 = angle.ratio === 1;
                ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : angle.color;
                ctx.lineWidth = is1x1 ? (gann.width + 1.5) : gann.width;
                ctx.globalAlpha = is1x1 ? 1 : 0.85;

                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(endX, endY);
                ctx.stroke();
                ctx.globalAlpha = 1;

                // Draw label with better positioning
                if (gann.showLabels) {
                    const labelDist = 80; // Fixed distance from anchor
                    const labelX = x1 + dirX * labelDist;
                    const labelY = y1 + dirY * labelDist;

                    // Background for better readability
                    ctx.font = 'bold 11px sans-serif';
                    const metrics = ctx.measureText(angle.label);
                    const padding = 4;
                    ctx.fillStyle = 'rgba(11, 14, 17, 0.85)';
                    ctx.fillRect(
                        labelX + 4 - padding,
                        labelY - 10 - padding,
                        metrics.width + padding * 2,
                        14 + padding * 2
                    );

                    // Label text
                    ctx.fillStyle = is1x1 ? '#ffffff' : angle.color;
                    ctx.fillText(angle.label, labelX + 4, labelY);
                }
            }
        } else if (gann.type === 'gann_box') {
            // === GANN BOX: Price/Time Grid with Square Subdivisions ===

            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);

            // Draw main box outline (thickest)
            ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : gann.color;
            ctx.lineWidth = 2.5;
            ctx.strokeRect(left, top, width, height);

            // Draw 8x8 grid subdivisions
            const divisions = 8;
            const cellWidth = width / divisions;
            const cellHeight = height / divisions;

            // Vertical grid lines
            for (let i = 1; i < divisions; i++) {
                const x = left + i * cellWidth;
                const isQuarter = i % 2 === 0; // Quarters (0, 2, 4, 6, 8)
                const isHalf = i === 4; // Midpoint

                ctx.strokeStyle = isHalf ? gann.color :
                    isQuarter ? gann.color : gann.color;
                ctx.lineWidth = isHalf ? 1.5 : isQuarter ? 1 : 0.5;
                ctx.globalAlpha = isHalf ? 0.7 : isQuarter ? 0.5 : 0.3;

                ctx.beginPath();
                ctx.moveTo(x, top);
                ctx.lineTo(x, top + height);
                ctx.stroke();
            }

            // Horizontal grid lines
            for (let i = 1; i < divisions; i++) {
                const y = top + i * cellHeight;
                const isQuarter = i % 2 === 0;
                const isHalf = i === 4;

                ctx.strokeStyle = isHalf ? gann.color :
                    isQuarter ? gann.color : gann.color;
                ctx.lineWidth = isHalf ? 1.5 : isQuarter ? 1 : 0.5;
                ctx.globalAlpha = isHalf ? 0.7 : isQuarter ? 0.5 : 0.3;

                ctx.beginPath();
                ctx.moveTo(left, y);
                ctx.lineTo(left + width, y);
                ctx.stroke();
            }

            ctx.globalAlpha = 1;

            // Draw diagonal lines (45° angles)
            ctx.setLineDash([4, 4]);
            ctx.strokeStyle = gann.color;
            ctx.lineWidth = 1;
            ctx.globalAlpha = 0.6;

            // Main diagonals (corner to corner)
            ctx.beginPath();
            ctx.moveTo(left, top);
            ctx.lineTo(left + width, top + height);
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(left + width, top);
            ctx.lineTo(left, top + height);
            ctx.stroke();

            // Gann angle lines within box (optional subset for key angles)
            const keyAngles = gann.angles.filter(a =>
                a.ratio === 1 || a.ratio === 2 || a.ratio === 0.5
            );

            for (const angle of keyAngles) {
                if (angle.ratio === 1) continue; // Already drew main diagonal

                // Calculate intersection with box edges
                const slope = angle.ratio * (height / width);

                ctx.strokeStyle = angle.color;
                ctx.globalAlpha = 0.4;
                ctx.beginPath();

                // Draw from bottom-left corner
                if (slope <= 1) {
                    ctx.moveTo(left, top + height);
                    ctx.lineTo(left + width, top + height - slope * width);
                } else {
                    ctx.moveTo(left, top + height);
                    ctx.lineTo(left + height / slope, top);
                }
                ctx.stroke();
            }

            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }

        // Draw anchor handles
        if (isSelected || isHovered) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = gann.color;
            ctx.lineWidth = 1.5;

            ctx.beginPath();
            ctx.arc(x1, y1, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Draw p2 handle
            ctx.beginPath();
            ctx.arc(x2, y2, HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }
    };

    // Render multi-point Pattern (XABCD, ABCD, Triangle, Head & Shoulders, Elliott Wave, etc.) - Enhanced
    const renderPattern = (ctx: CanvasRenderingContext2D, pattern: DrawingPattern, rs: PluginRenderState) => {
        if (pattern.points.length < 2) return;

        const isSelected = state.selectedPatternId === pattern.id;
        const isHovered = state.hoveredPatternId === pattern.id;

        // Convert points to screen coordinates
        const screenPoints = pattern.points.map(p => ({
            x: rs.snapX(rs.timeToX(p.time)),
            y: rs.snapY(rs.valueToY(p.price)),
        }));

        // Elliott Wave specific validation and coloring
        const isElliot = pattern.type.startsWith('elliott_');
        let hasViolation = false;

        if (isElliot && pattern.type === 'elliott_impulse' && pattern.points.length === 5) {
            // Validate Elliott Wave Impulse rules
            const wave1 = Math.abs(pattern.points[1].price - pattern.points[0].price);
            const wave3 = Math.abs(pattern.points[3].price - pattern.points[2].price);
            const wave5 = Math.abs(pattern.points[4].price - pattern.points[3].price);

            // Rule 1: Wave 3 cannot be the shortest
            if (wave3 < wave1 && wave3 < wave5) {
                hasViolation = true;
            }

            // Rule 2: Wave 4 cannot overlap Wave 1 price territory
            const wave1Top = Math.max(pattern.points[0].price, pattern.points[1].price);
            const wave1Bottom = Math.min(pattern.points[0].price, pattern.points[1].price);
            const wave4Price = pattern.points[3].price;

            if (wave4Price > wave1Bottom && wave4Price < wave1Top) {
                hasViolation = true;
            }
        }

        // Harmonic Pattern specific validation and ratio checking
        const isHarmonic = ['xabcd', 'abcd', 'cypher', 'three_drives'].includes(pattern.type);
        let harmonicRatios: { leg: string; ratio: number; isValid: boolean }[] = [];
        let isPRZ = false; // Potential Reversal Zone

        if (isHarmonic && pattern.points.length >= 4) {
            if (pattern.type === 'xabcd' && pattern.points.length === 5) {
                // XABCD: X-A-B-C-D pattern with Fibonacci ratios
                const XA = Math.abs(pattern.points[1].price - pattern.points[0].price);
                const AB = Math.abs(pattern.points[2].price - pattern.points[1].price);
                const BC = Math.abs(pattern.points[3].price - pattern.points[2].price);
                const CD = Math.abs(pattern.points[4].price - pattern.points[3].price);

                // Common XABCD ratios
                const ABxaRatio = XA > 0 ? AB / XA : 0;
                const BCabRatio = AB > 0 ? BC / AB : 0;
                const CDxaRatio = XA > 0 ? CD / XA : 0;

                // Ideal ratios: AB=0.618 XA, CD=1.272 XA or AB=CD
                harmonicRatios.push(
                    { leg: 'AB/XA', ratio: ABxaRatio, isValid: ABxaRatio >= 0.382 && ABxaRatio <= 0.886 },
                    { leg: 'BC/AB', ratio: BCabRatio, isValid: BCabRatio >= 0.382 && BCabRatio <= 0.886 },
                    { leg: 'CD/XA', ratio: CDxaRatio, isValid: CDxaRatio >= 1.13 && CDxaRatio <= 1.618 }
                );

                // PRZ at point D
                isPRZ = true;

            } else if (pattern.type === 'abcd' && pattern.points.length === 4) {
                // ABCD: A-B-C-D pattern
                const AB = Math.abs(pattern.points[1].price - pattern.points[0].price);
                const BC = Math.abs(pattern.points[2].price - pattern.points[1].price);
                const CD = Math.abs(pattern.points[3].price - pattern.points[2].price);

                const BCabRatio = AB > 0 ? BC / AB : 0;
                const CDabRatio = AB > 0 ? CD / AB : 0;

                harmonicRatios.push(
                    { leg: 'BC/AB', ratio: BCabRatio, isValid: BCabRatio >= 0.382 && BCabRatio <= 0.886 },
                    { leg: 'CD/AB', ratio: CDabRatio, isValid: CDabRatio >= 1.13 && CDabRatio <= 1.618 }
                );

                isPRZ = true;

            } else if (pattern.type === 'cypher' && pattern.points.length === 5) {
                // Cypher: Specific harmonic variant with strict ratios
                const XA = Math.abs(pattern.points[1].price - pattern.points[0].price);
                const AB = Math.abs(pattern.points[2].price - pattern.points[1].price);
                const XC = Math.abs(pattern.points[3].price - pattern.points[0].price);
                const CD = Math.abs(pattern.points[4].price - pattern.points[3].price);

                const ABxaRatio = XA > 0 ? AB / XA : 0;
                const XCxaRatio = XA > 0 ? XC / XA : 0;
                const CDxcRatio = XC > 0 ? CD / XC : 0;

                // Cypher ratios: AB=0.382-0.618 XA, XC=1.272-1.414 XA
                harmonicRatios.push(
                    { leg: 'AB/XA', ratio: ABxaRatio, isValid: ABxaRatio >= 0.382 && ABxaRatio <= 0.618 },
                    { leg: 'XC/XA', ratio: XCxaRatio, isValid: XCxaRatio >= 1.272 && XCxaRatio <= 1.414 },
                    { leg: 'CD/XC', ratio: CDxcRatio, isValid: CDxcRatio >= 0.786 && CDxcRatio <= 0.886 }
                );

                isPRZ = true;

            } else if (pattern.type === 'three_drives' && pattern.points.length === 6) {
                // Three Drives: 1-A-2-B-3-C pattern with symmetric moves
                const drive1 = Math.abs(pattern.points[1].price - pattern.points[0].price);
                const drive2 = Math.abs(pattern.points[3].price - pattern.points[2].price);
                const drive3 = Math.abs(pattern.points[5].price - pattern.points[4].price);

                const d2d1Ratio = drive1 > 0 ? drive2 / drive1 : 0;
                const d3d1Ratio = drive1 > 0 ? drive3 / drive1 : 0;

                harmonicRatios.push(
                    { leg: 'Drive2/1', ratio: d2d1Ratio, isValid: d2d1Ratio >= 1.13 && d2d1Ratio <= 1.618 },
                    { leg: 'Drive3/1', ratio: d3d1Ratio, isValid: d3d1Ratio >= 1.13 && d3d1Ratio <= 1.618 }
                );

                isPRZ = true;
            }
        }

        // Draw fill if enabled
        if (pattern.fillColor && pattern.fillOpacity && pattern.fillOpacity > 0) {
            ctx.globalAlpha = pattern.fillOpacity;
            ctx.fillStyle = pattern.fillColor;
            ctx.beginPath();
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
            for (let i = 1; i < screenPoints.length; i++) {
                ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // Draw connected segments with Elliott Wave coloring
        ctx.lineWidth = pattern.width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        if (isElliot) {
            // Elliott Wave: Color motive waves differently from corrective waves
            const motiveColor = hasViolation ? '#f23645' : '#089981';  // Green for valid, red for violation
            const correctiveColor = '#2962ff';  // Blue for corrective

            for (let i = 0; i < screenPoints.length - 1; i++) {
                // For impulse: waves 1, 3, 5 are motive (odd), waves 2, 4 are corrective (even)
                const isMotiveWave = pattern.type === 'elliott_impulse' ? (i % 2 === 0) : false;
                const waveColor = isMotiveWave ? motiveColor : correctiveColor;

                ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : waveColor;
                ctx.beginPath();
                ctx.moveTo(screenPoints[i].x, screenPoints[i].y);
                ctx.lineTo(screenPoints[i + 1].x, screenPoints[i + 1].y);
                ctx.stroke();
            }
        } else {
            // Standard pattern rendering
            ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : pattern.color;
            ctx.beginPath();
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
            for (let i = 1; i < screenPoints.length; i++) {
                ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
            }
            ctx.stroke();
        }

        // Draw Fibonacci ratios between points if enabled
        if (pattern.showRatios && screenPoints.length >= 3) {
            if (isHarmonic && harmonicRatios.length > 0) {
                // Harmonic Pattern: Show calculated Fibonacci ratios with validation
                ctx.font = 'bold 11px sans-serif';

                // Draw PRZ zone at completion point (last point)
                if (isPRZ && screenPoints.length >= 4) {
                    const przPoint = screenPoints[screenPoints.length - 1];
                    const przRadius = 30;

                    // PRZ circle/zone
                    ctx.fillStyle = 'rgba(41, 98, 255, 0.15)';
                    ctx.beginPath();
                    ctx.arc(przPoint.x, przPoint.y, przRadius, 0, Math.PI * 2);
                    ctx.fill();

                    // PRZ label
                    ctx.font = 'bold 9px sans-serif';
                    ctx.fillStyle = '#2962ff';
                    ctx.fillText('PRZ', przPoint.x - 12, przPoint.y + przRadius + 12);
                    ctx.font = 'bold 11px sans-serif';
                }

                // Display ratios with color coding
                let ratioY = screenPoints[0].y - 50;
                for (const ratioInfo of harmonicRatios) {
                    const ratioText = `${ratioInfo.leg}: ${ratioInfo.ratio.toFixed(3)}`;
                    const ratioColor = ratioInfo.isValid ? '#089981' : '#f23645';

                    // Background
                    const metrics = ctx.measureText(ratioText);
                    ctx.fillStyle = 'rgba(11, 14, 17, 0.9)';
                    ctx.fillRect(screenPoints[0].x + 5, ratioY - 12, metrics.width + 8, 16);

                    // Text
                    ctx.fillStyle = ratioColor;
                    ctx.fillText(ratioText, screenPoints[0].x + 9, ratioY);

                    ratioY += 18;
                }

            } else {
                // Standard pattern ratio display
                ctx.font = '10px sans-serif';
                ctx.fillStyle = pattern.color;

                // Calculate ratios for XABCD/ABCD patterns
                for (let i = 2; i < pattern.points.length; i++) {
                    const priceDiff1 = Math.abs(pattern.points[i - 1].price - pattern.points[i - 2].price);
                    const priceDiff2 = Math.abs(pattern.points[i].price - pattern.points[i - 1].price);

                    if (priceDiff1 > 0) {
                        const ratio = (priceDiff2 / priceDiff1).toFixed(3);
                        const midX = (screenPoints[i - 1].x + screenPoints[i].x) / 2;
                        const midY = (screenPoints[i - 1].y + screenPoints[i].y) / 2;

                        // Background for ratio label
                        const metrics = ctx.measureText(ratio);
                        ctx.fillStyle = 'rgba(11, 14, 17, 0.85)';
                        ctx.fillRect(midX + 2, midY - 13, metrics.width + 6, 14);

                        ctx.fillStyle = pattern.color;
                        ctx.fillText(ratio, midX + 5, midY - 5);
                    }
                }
            }
        }

        // Draw point labels with enhanced styling for Elliott Wave
        if (pattern.showLabels) {
            ctx.font = isElliot ? 'bold 13px sans-serif' : 'bold 12px sans-serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';

            for (let i = 0; i < screenPoints.length; i++) {
                const label = pattern.labels[i] || (i + 1).toString();
                const x = screenPoints[i].x;
                const y = screenPoints[i].y;

                // Determine label position (above or below point based on wave direction)
                let labelOffsetY = -22;  // Default: above point
                if (i > 0) {
                    const prevY = screenPoints[i - 1].y;
                    // If wave went down, put label below
                    if (y > prevY) {
                        labelOffsetY = 22;
                    }
                }

                // Draw label background
                const metrics = ctx.measureText(label);
                const padding = 5;
                const bgWidth = metrics.width + padding * 2;
                const bgHeight = 18;

                // Color code based on wave type for Elliott
                let labelBg = isSelected ? '#fc7432' : pattern.color;
                if (isElliot && pattern.type === 'elliott_impulse') {
                    const isMotiveWave = i % 2 === 0;  // Waves 1, 3, 5
                    labelBg = isMotiveWave ? (hasViolation ? '#f23645' : '#089981') : '#2962ff';
                }

                ctx.fillStyle = labelBg;
                ctx.fillRect(x - bgWidth / 2, y + labelOffsetY - bgHeight / 2, bgWidth, bgHeight);

                // Draw label text
                ctx.fillStyle = '#ffffff';
                ctx.fillText(label, x, y + labelOffsetY);
            }
            ctx.textAlign = 'left';
        }

        // Draw selection handles at each point
        if (isSelected || isHovered) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = pattern.color;
            ctx.lineWidth = 1.5;

            for (const point of screenPoints) {
                ctx.beginPath();
                ctx.arc(point.x, point.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }


        // Chart Pattern specific rendering (trend lines, necklines, projections)
        const isChartPattern = ['triangle', 'head_shoulders', 'wedge', 'double_top', 'double_bottom'].includes(pattern.type);

        if (isChartPattern && screenPoints.length >= 3) {
            ctx.setLineDash([5, 5]);
            ctx.globalAlpha = 0.7;

            if (pattern.type === 'triangle' && screenPoints.length >= 3) {
                // Triangle: Draw converging trend lines (upper and lower)
                // Assume points alternate between highs and lows, or use first/last for trend lines
                const highs = screenPoints.filter((_, i) => i % 2 === 0);
                const lows = screenPoints.filter((_, i) => i % 2 === 1);

                if (highs.length >= 2) {
                    // Upper trend line
                    const dx = highs[highs.length - 1].x - highs[0].x;
                    const dy = highs[highs.length - 1].y - highs[0].y;
                    const extendX = highs[highs.length - 1].x + dx * 0.5;
                    const extendY = highs[highs.length - 1].y + dy * 0.5;

                    ctx.strokeStyle = '#2962ff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(highs[0].x, highs[0].y);
                    ctx.lineTo(extendX, extendY);
                    ctx.stroke();
                }

                if (lows.length >= 2) {
                    // Lower trend line
                    const dx = lows[lows.length - 1].x - lows[0].x;
                    const dy = lows[lows.length - 1].y - lows[0].y;
                    const extendX = lows[lows.length - 1].x + dx * 0.5;
                    const extendY = lows[lows.length - 1].y + dy * 0.5;

                    ctx.strokeStyle = '#2962ff';
                    ctx.lineWidth = 2;
                    ctx.beginPath();
                    ctx.moveTo(lows[0].x, lows[0].y);
                    ctx.lineTo(extendX, extendY);
                    ctx.stroke();
                }

            } else if (pattern.type === 'head_shoulders' && screenPoints.length >= 5) {
                // Head & Shoulders: LS-Head-RS with neckline between NL points
                const neckline1 = screenPoints[3]; // NL left
                const neckline2 = screenPoints[4]; // NL right
                const head = screenPoints[1]; // Head (highest point)

                // Draw neckline (extended)
                const neckDx = neckline2.x - neckline1.x;
                const neckDy = neckline2.y - neckline1.y;
                const extendFactor = 0.3;

                ctx.strokeStyle = '#f23645';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(neckline1.x - neckDx * extendFactor, neckline1.y - neckDy * extendFactor);
                ctx.lineTo(neckline2.x + neckDx * extendFactor, neckline2.y + neckDy * extendFactor);
                ctx.stroke();

                // Draw target projection (head distance below neckline)
                const headToNeck = Math.abs(head.y - neckline1.y);
                const targetY = neckline2.y + headToNeck;

                ctx.strokeStyle = '#089981';
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(neckline2.x, neckline2.y);
                ctx.lineTo(neckline2.x, targetY);
                ctx.stroke();

                // Target label
                ctx.font = '10px sans-serif';
                ctx.fillStyle = '#089981';
                ctx.fillText('Target', neckline2.x + 5, targetY);

            } else if (pattern.type === 'wedge' && screenPoints.length >= 4) {
                // Wedge: Two converging trend lines (rising or falling)
                // Points 0,2 = upper trend, points 1,3 = lower trend
                const upper1 = screenPoints[0];
                const upper2 = screenPoints[2];
                const lower1 = screenPoints[1];
                const lower2 = screenPoints[3];

                // Upper trend line
                const upperDx = upper2.x - upper1.x;
                const upperDy = upper2.y - upper1.y;
                const upperExtendX = upper2.x + upperDx * 0.4;
                const upperExtendY = upper2.y + upperDy * 0.4;

                ctx.strokeStyle = '#2962ff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.moveTo(upper1.x, upper1.y);
                ctx.lineTo(upperExtendX, upperExtendY);
                ctx.stroke();

                // Lower trend line
                const lowerDx = lower2.x - lower1.x;
                const lowerDy = lower2.y - lower1.y;
                const lowerExtendX = lower2.x + lowerDx * 0.4;
                const lowerExtendY = lower2.y + lowerDy * 0.4;

                ctx.beginPath();
                ctx.moveTo(lower1.x, lower1.y);
                ctx.lineTo(lowerExtendX, lowerExtendY);
                ctx.stroke();

                // Direction label (rising/falling)
                const isRising = upperDy > 0 && lowerDy > 0;
                const direction = isRising ? 'Rising ↗' : 'Falling ↘';
                ctx.font = 'bold 11px sans-serif';
                ctx.fillStyle = isRising ? '#f23645' : '#089981';
                ctx.fillText(direction, (upper2.x + lower2.x) / 2, upper2.y - 25);

            } else if ((pattern.type === 'double_top' || pattern.type === 'double_bottom') && screenPoints.length >= 3) {
                // Double Top/Bottom: Two peaks + neckline
                const peak1 = screenPoints[0];
                const peak2 = screenPoints[1];
                const neckline = screenPoints[2];

                // Horizontal neckline (extended)
                const necklineY = neckline.y;
                const minX = Math.min(peak1.x, peak2.x, neckline.x);
                const maxX = Math.max(peak1.x, peak2.x, neckline.x);
                const extension = (maxX - minX) * 0.2;

                ctx.strokeStyle = '#f23645';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.moveTo(minX - extension, necklineY);
                ctx.lineTo(maxX + extension, necklineY);
                ctx.stroke();

                // Target projection (peak distance from neckline)
                const peakToNeck = Math.abs(peak1.y - necklineY);
                const targetY = pattern.type === 'double_top' ?
                    necklineY + peakToNeck : // Top: target below
                    necklineY - peakToNeck;   // Bottom: target above

                ctx.strokeStyle = '#089981';
                ctx.setLineDash([3, 3]);
                ctx.beginPath();
                ctx.moveTo(maxX, necklineY);
                ctx.lineTo(maxX, targetY);
                ctx.stroke();

                // Target label
                ctx.font = '10px sans-serif';
                ctx.fillStyle = '#089981';
                ctx.fillText('Target', maxX + 5, targetY);
            }

            ctx.setLineDash([]);
            ctx.globalAlpha = 1;
        }

        // Draw violation warning for invalid Elliott Wave
        if (hasViolation && isSelected) {
            ctx.font = '10px sans-serif';
            ctx.fillStyle = '#f23645';
            const warningX = screenPoints[0].x;
            const warningY = screenPoints[0].y - 40;
            ctx.fillText('⚠️ Wave 3 shortest or Wave 4 overlaps!', warningX, warningY);
        }
    };

    // Render Position/Trade Planning Tool (Long/Short with entry, target, stop)
    const renderPosition = (ctx: CanvasRenderingContext2D, position: DrawingPosition, rs: PluginRenderState) => {
        const isSelected = state.selectedPositionId === position.id;
        const isHovered = state.hoveredPositionId === position.id;

        // Convert prices to Y coordinates
        const entryY = rs.snapY(rs.valueToY(position.entryPrice));
        const targetY = rs.snapY(rs.valueToY(position.targetPrice));
        const stopY = rs.snapY(rs.valueToY(position.stopPrice));

        // Convert times to X coordinates
        const startX = rs.snapX(rs.timeToX(position.startTime));
        const endX = rs.snapX(rs.timeToX(position.endTime));
        const width = Math.abs(endX - startX);
        const left = Math.min(startX, endX);

        // Determine profit/loss zones based on position type
        const isLong = position.type === 'long';
        const profitTop = isLong ? targetY : entryY;
        const profitBottom = isLong ? entryY : targetY;
        const lossTop = isLong ? entryY : stopY;
        const lossBottom = isLong ? stopY : entryY;

        // Draw profit zone (green)
        ctx.globalAlpha = position.opacity;
        ctx.fillStyle = position.profitColor;
        ctx.fillRect(left, Math.min(profitTop, profitBottom), width, Math.abs(profitBottom - profitTop));

        // Draw loss zone (red)
        ctx.fillStyle = position.lossColor;
        ctx.fillRect(left, Math.min(lossTop, lossBottom), width, Math.abs(lossBottom - lossTop));
        ctx.globalAlpha = 1;

        // Draw entry line (solid)
        ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : position.entryColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(left, entryY);
        ctx.lineTo(left + width, entryY);
        ctx.stroke();

        // Draw targets from targets array if present
        if (position.targets && position.targets.length > 0) {
            position.targets.forEach((target, index) => {
                const tY = rs.snapY(rs.valueToY(target.price));

                // Draw target line
                ctx.strokeStyle = position.profitColor;
                ctx.lineWidth = 1;
                ctx.setLineDash([5, 3]);
                ctx.beginPath();
                ctx.moveTo(left, tY);
                ctx.lineTo(left + width, tY);
                ctx.stroke();

                // Label
                if (position.showLabels) {
                    ctx.fillStyle = position.profitColor;
                    ctx.fillText(target.label || `TP${index + 1}: ${target.price.toFixed(2)}`, left + 5, tY - 4);

                    // Show percentage if available
                    if (target.percentage) {
                        ctx.textAlign = 'right';
                        ctx.fillText(`${target.percentage}%`, left + width - 5, tY - 4);
                        ctx.textAlign = 'left';
                    }
                }
            });
        } else {
            // Draw single target line (dashed green)
            ctx.strokeStyle = position.profitColor;
            ctx.lineWidth = 1.5;
            ctx.setLineDash([5, 3]);
            ctx.beginPath();
            ctx.moveTo(left, targetY);
            ctx.lineTo(left + width, targetY);
            ctx.stroke();
        }

        // Draw stop line (dashed red)
        ctx.strokeStyle = position.lossColor;
        ctx.beginPath();
        ctx.moveTo(left, stopY);
        ctx.lineTo(left + width, stopY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw labels and R:R ratio
        if (position.showLabels) {
            ctx.font = '11px sans-serif';
            ctx.textBaseline = 'middle';

            // Entry label
            ctx.fillStyle = position.entryColor;
            ctx.textAlign = 'left';
            ctx.fillText(`Entry: ${position.entryPrice.toFixed(2)}`, left + 5, entryY);

            // Target label (if single)
            if (!position.targets || position.targets.length === 0) {
                ctx.fillStyle = position.profitColor;
                ctx.fillText(`TP: ${position.targetPrice.toFixed(2)}`, left + 5, targetY);
            }

            // Stop label
            ctx.fillStyle = position.lossColor;
            ctx.fillText(`SL: ${position.stopPrice.toFixed(2)}`, left + 5, stopY);
        }

        // Draw R:R ratio
        if (position.showRatio) {
            const risk = Math.abs(position.entryPrice - position.stopPrice);
            const reward = Math.abs(position.targetPrice - position.entryPrice);
            const ratio = risk > 0 ? (reward / risk).toFixed(2) : '∞';

            ctx.font = 'bold 12px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';

            // Draw R:R badge
            const badgeText = `R:R ${ratio}`;
            const metrics = ctx.measureText(badgeText);
            const badgeWidth = metrics.width + 12;
            const badgeHeight = 20;
            const badgeX = left + width / 2 - badgeWidth / 2;
            const badgeY = Math.min(entryY, targetY, stopY) - badgeHeight - 5;

            ctx.fillStyle = isLong ? position.profitColor : position.lossColor;
            ctx.beginPath();
            ctx.roundRect(badgeX, badgeY, badgeWidth, badgeHeight, 4);
            ctx.fill();

            ctx.fillStyle = '#ffffff';
            ctx.fillText(badgeText, left + width / 2, badgeY + badgeHeight / 2);
        }

        // Draw selection border
        if (isSelected || isHovered) {
            const top = Math.min(targetY, stopY); // Basic bounding calc
            // Real bounding box might need to include max target... keeping simple for now
            const boundTop = isLong ? Math.min(stopY, ...position.targets?.map(t => rs.valueToY(t.price)) ?? [targetY], entryY)
                : Math.min(stopY, ...position.targets?.map(t => rs.valueToY(t.price)) ?? [targetY], entryY);
            const boundBottom = isLong ? Math.max(stopY, ...position.targets?.map(t => rs.valueToY(t.price)) ?? [targetY], entryY)
                : Math.max(stopY, ...position.targets?.map(t => rs.valueToY(t.price)) ?? [targetY], entryY);

            ctx.strokeStyle = '#fc7432';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(left, boundTop, width, Math.abs(boundBottom - boundTop));
            ctx.setLineDash([]);
        }
    };

    const renderForecast = (ctx: CanvasRenderingContext2D, forecast: DrawingForecast, rs: PluginRenderState) => {
        const x1 = rs.snapX(rs.timeToX(forecast.startPoint.time));
        const y1 = rs.snapY(rs.valueToY(forecast.startPoint.price));
        const x2 = forecast.endPoint ? rs.snapX(rs.timeToX(forecast.endPoint.time)) : x1 + 50;
        const y2 = forecast.endPoint ? rs.snapY(rs.valueToY(forecast.endPoint.price)) : y1 - 50;

        const isSelected = state.selectedForecastId === forecast.id;
        const isHovered = state.hoveredForecastId === forecast.id;

        ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : forecast.color;
        ctx.lineWidth = forecast.width;

        if (forecast.style === 'dashed') ctx.setLineDash([6, 4]);
        else if (forecast.style === 'dotted') ctx.setLineDash([2, 4]);
        else ctx.setLineDash([]);

        if (forecast.type === 'forecast' || forecast.type === 'projection') {
            // Draw arrow
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            // Arrowhead
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const headLen = 10;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - headLen * Math.cos(angle - Math.PI / 6), y2 - headLen * Math.sin(angle - Math.PI / 6));
            ctx.lineTo(x2 - headLen * Math.cos(angle + Math.PI / 6), y2 - headLen * Math.sin(angle + Math.PI / 6));
            ctx.fillStyle = isSelected || isHovered ? '#fc7432' : forecast.color;
            ctx.fill();
        } else if (forecast.type === 'bars_pattern' || forecast.type === 'ghost_feed') {
            // Placeholder box for bars pattern
            ctx.fillStyle = forecast.color;
            ctx.font = '10px sans-serif';
            ctx.fillText(forecast.type === 'bars_pattern' ? '[Bars Pattern]' : '[Ghost Feed]', x1 + 5, y1 + 15);
        }
    };

    const renderPath = (ctx: CanvasRenderingContext2D, path: DrawingPath, rs: PluginRenderState) => {
        if (path.points.length < 2) return;

        const screenPoints = path.points.map(p => ({
            x: rs.snapX(rs.timeToX(p.time)),
            y: rs.snapY(rs.valueToY(p.price))
        }));

        const isSelected = state.selectedPathId === path.id; // Need to add to state
        const isHovered = state.hoveredPathId === path.id;   // Need to add to state

        // Highlighter: thick semi-transparent stroke
        if (path.type === 'highlighter') {
            ctx.strokeStyle = path.color;
            ctx.lineWidth = 20;  // Much thicker than brush
            ctx.globalAlpha = 0.3;  // Semi-transparent
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
        } else {
            ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : path.color;
            ctx.lineWidth = path.width;
        }

        if (path.style === 'dashed') ctx.setLineDash([6, 4]);
        else if (path.style === 'dotted') ctx.setLineDash([2, 4]);
        else ctx.setLineDash([]);

        ctx.beginPath();
        ctx.moveTo(screenPoints[0].x, screenPoints[0].y);

        if (path.smooth && screenPoints.length > 2) {
            // Simple Bezier smoothing
            for (let i = 1; i < screenPoints.length - 2; i++) {
                const xc = (screenPoints[i].x + screenPoints[i + 1].x) / 2;
                const yc = (screenPoints[i].y + screenPoints[i + 1].y) / 2;
                ctx.quadraticCurveTo(screenPoints[i].x, screenPoints[i].y, xc, yc);
            }
            // curve through the last two points
            ctx.quadraticCurveTo(
                screenPoints[screenPoints.length - 2].x,
                screenPoints[screenPoints.length - 2].y,
                screenPoints[screenPoints.length - 1].x,
                screenPoints[screenPoints.length - 1].y
            );
        } else {
            // Linear path
            for (let i = 1; i < screenPoints.length; i++) {
                ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
            }
        }

        if (path.closed) {
            ctx.closePath();
            if (path.fillColor) {
                ctx.globalAlpha = path.fillOpacity || 0.1;
                ctx.fillStyle = path.fillColor;
                ctx.fill();
                ctx.globalAlpha = 1;
            }
        }

        ctx.stroke();

        // Reset alpha if highlighter
        if (path.type === 'highlighter') {
            ctx.globalAlpha = 1;
        }

        // Draw handles if selected
        if (isSelected) {
            ctx.fillStyle = '#ffffff';
            ctx.strokeStyle = path.color;
            ctx.lineWidth = 1;
            ctx.setLineDash([]);
            for (const p of screenPoints) {
                ctx.beginPath();
                ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
        }
    };

    const renderArc = (ctx: CanvasRenderingContext2D, arc: DrawingArc, rs: PluginRenderState) => {
        // Arc defined by 3 points: p1(start), p2(end), p3(control/height)
        const x1 = rs.snapX(rs.timeToX(arc.p1.time));
        const y1 = rs.snapY(rs.valueToY(arc.p1.price));
        const x2 = rs.snapX(rs.timeToX(arc.p2.time));
        const y2 = rs.snapY(rs.valueToY(arc.p2.price));

        // If p3 is not yet set (during drawing), use p2 or mouse
        if (!arc.p3) return; // Should handle incomplete arc in preview

        const x3 = rs.snapX(rs.timeToX(arc.p3.time));
        const y3 = rs.snapY(rs.valueToY(arc.p3.price));

        const isSelected = state.selectedArcId === arc.id; // Need to add to state
        const isHovered = state.hoveredArcId === arc.id;   // Need to add to state

        ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : arc.color;
        ctx.lineWidth = arc.width;

        if (arc.style === 'dashed') ctx.setLineDash([6, 4]);
        else if (arc.style === 'dotted') ctx.setLineDash([2, 4]);
        else ctx.setLineDash([]);

        // 3-point Arc Logic: fit circle through 3 points
        // Center calculation
        const D = 2 * (x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2));
        if (Math.abs(D) < 0.001) {
            // Collinear points - draw line
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x3, y3); // goes through p3 (control)? or p2? 
            // Logic for arc: start p1, end p2, p3 is on arc.
            // If collinear, line p1 -> p2
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            return;
        }

        const centerX = ((x1 * x1 + y1 * y1) * (y2 - y3) + (x2 * x2 + y2 * y2) * (y3 - y1) + (x3 * x3 + y3 * y3) * (y1 - y2)) / D;
        const centerY = ((x1 * x1 + y1 * y1) * (x3 - x2) + (x2 * x2 + y2 * y2) * (x1 - x3) + (x3 * x3 + y3 * y3) * (x2 - x1)) / D;

        const radius = Math.sqrt((x1 - centerX) ** 2 + (y1 - centerY) ** 2);

        const startAngle = Math.atan2(y1 - centerY, x1 - centerX);
        const endAngle = Math.atan2(y2 - centerY, x2 - centerX);
        const midAngle = Math.atan2(y3 - centerY, x3 - centerX);

        // Determine direction (CW or CCW) checking midAngle
        // Should draw from startAngle to endAngle passing through midAngle

        let counterClockwise = false;
        // Normalize angles to 0-2PI for comparison
        // ... Simplified arc render: just draw the circle segment

        ctx.beginPath();
        ctx.arc(centerX, centerY, radius, startAngle, endAngle, counterClockwise);
        // This might draw the "long way" around. Need to check if midAngle is inside.
        const isMidBetween = (midAngle > Math.min(startAngle, endAngle) && midAngle < Math.max(startAngle, endAngle));
        // Complex logic for exact arc direction... 
        // Fallback: quadratic curve for visual approximation (easier / faster)
        // ctx.moveTo(x1, y1);
        // ctx.quadraticCurveTo(x3, y3, x2, y2); // This only works if p3 is control point, not point on arc

        // Correct circle logic: 
        // Check cross product to see if points are CW or CCW order?

        // Re-draw with correct direction check:
        ctx.beginPath();

        // Check orientation
        // Vector 1->2 vs 1->3
        const val = (x2 - x1) * (y3 - y1) - (y2 - y1) * (x3 - x1);
        // if val > 0, p3 is left of p1->p2

        // Just draw full circle for now or try to be smart? 
        // Let's use `arc` but assume CCW based on interaction

        // Easier: Draw p1 to p2 via p3
        // Use arcTo? No. 
        // Basic Circle Arc:
        // Determine if we need to go CW or CCW to hit p3.
        // Normalized angles:
        const a1 = (startAngle + 2 * Math.PI) % (2 * Math.PI);
        const a2 = (endAngle + 2 * Math.PI) % (2 * Math.PI);
        const a3 = (midAngle + 2 * Math.PI) % (2 * Math.PI);

        if (a1 < a2) {
            if (a1 < a3 && a3 < a2) counterClockwise = false;
            else counterClockwise = true;
        } else {
            if (a2 < a3 && a3 < a1) counterClockwise = true;
            else counterClockwise = false;
        }

        ctx.arc(centerX, centerY, radius, startAngle, endAngle, counterClockwise);
        ctx.stroke();

        // Handles
        if (isSelected) {
            ctx.fillStyle = '#ffffff';
            [{ x: x1, y: y1 }, { x: x2, y: y2 }, { x: x3, y: y3 }].forEach(p => {
                ctx.beginPath();
                ctx.arc(p.x, p.y, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            });
        }

    };

    const renderPending = (ctx: CanvasRenderingContext2D, rs: PluginRenderState) => {
        if (!state.pendingPoint) return;

        const x1 = rs.snapX(rs.timeToX(state.pendingPoint.time));
        const y1 = rs.snapY(rs.valueToY(state.pendingPoint.price));

        // Use pre-calculated constrained coordinates (updated in onPointer)
        const x2 = rs.snapX(constrainedMouseX);
        const y2 = rs.snapY(constrainedMouseY);


        const plotLeft = rs.plotRect.x;
        const plotRight = rs.plotRect.x + rs.plotRect.width;
        const plotTop = rs.plotRect.y;
        const plotBottom = rs.plotRect.y + rs.plotRect.height;

        ctx.strokeStyle = '#fc7432';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 4]);
        ctx.lineCap = 'round';

        if (state.activeTool === 'horizontal') {
            ctx.beginPath();
            ctx.moveTo(plotLeft, y1);
            ctx.lineTo(plotRight, y1);
            ctx.stroke();
        } else if (state.activeTool === 'vertical') {
            ctx.beginPath();
            ctx.moveTo(x1, plotTop);
            ctx.lineTo(x1, plotBottom);
            ctx.stroke();
        } else if (state.activeTool === 'ray') {
            // Ray: extends from p1 through p2 to edge
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0.001) {
                const dirX = dx / len;
                const dirY = dy / len;
                // Calculate intersection with canvas edge
                let t = 10000;
                if (Math.abs(dirX) > 0.001) {
                    const tRight = (plotRight - x1) / dirX;
                    const tLeft = (plotLeft - x1) / dirX;
                    t = Math.min(t, dirX > 0 ? tRight : -tLeft);
                }
                if (Math.abs(dirY) > 0.001) {
                    const tBottom = (plotBottom - y1) / dirY;
                    const tTop = (plotTop - y1) / dirY;
                    t = Math.min(t, dirY > 0 ? tBottom : -tTop);
                }
                const endX = x1 + dirX * Math.max(t, len);
                const endY = y1 + dirY * Math.max(t, len);
                ctx.beginPath();
                ctx.moveTo(x1, y1);
                ctx.lineTo(endX, endY);
                ctx.stroke();
            }
        } else if (state.activeTool === 'extended') {
            // Extended: extends in both directions to edges
            const dx = x2 - x1;
            const dy = y2 - y1;
            const len = Math.sqrt(dx * dx + dy * dy);
            if (len > 0.001) {
                const dirX = dx / len;
                const dirY = dy / len;
                // Calculate intersections with canvas edges in both directions
                let tForward = 10000, tBackward = 10000;
                if (Math.abs(dirX) > 0.001) {
                    tForward = Math.min(tForward, dirX > 0 ? (plotRight - x1) / dirX : (plotLeft - x1) / dirX);
                    tBackward = Math.min(tBackward, dirX > 0 ? (x1 - plotLeft) / dirX : (x1 - plotRight) / dirX);
                }
                if (Math.abs(dirY) > 0.001) {
                    tForward = Math.min(tForward, dirY > 0 ? (plotBottom - y1) / dirY : (plotTop - y1) / dirY);
                    tBackward = Math.min(tBackward, dirY > 0 ? (y1 - plotTop) / dirY : (y1 - plotBottom) / dirY);
                }
                const startX = x1 - dirX * tBackward;
                const startY = y1 - dirY * tBackward;
                const endX = x1 + dirX * tForward;
                const endY = y1 + dirY * tForward;
                ctx.beginPath();
                ctx.moveTo(startX, startY);
                ctx.lineTo(endX, endY);
                ctx.stroke();
            }
        } else if (state.activeTool === 'arrow') {
            // Arrow: line with arrowhead at p2
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
            // Draw arrowhead
            ctx.setLineDash([]);
            const angle = Math.atan2(y2 - y1, x2 - x1);
            const arrowLen = 12;
            const arrowAngle = Math.PI / 6;
            ctx.beginPath();
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - arrowLen * Math.cos(angle - arrowAngle), y2 - arrowLen * Math.sin(angle - arrowAngle));
            ctx.moveTo(x2, y2);
            ctx.lineTo(x2 - arrowLen * Math.cos(angle + arrowAngle), y2 - arrowLen * Math.sin(angle + arrowAngle));
            ctx.stroke();
            ctx.setLineDash([4, 4]);
        } else if (state.activeTool === 'rectangle' || state.activeTool === 'price_range' || state.activeTool === 'date_range' || state.activeTool === 'combined_range' || state.activeTool === 'fixed_range_volume_profile') {
            // Rectangle/Measure preview with fill
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);
            // Draw fill
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = '#fc7432';
            ctx.fillRect(left, top, width, height);
            ctx.globalAlpha = 1;
            // Draw stroke
            ctx.beginPath();
            ctx.rect(left, top, width, height);
            ctx.stroke();
        } else if (state.activeTool === 'ellipse') {
            // Ellipse preview with fill
            const left = Math.min(x1, x2);
            const top = Math.min(y1, y2);
            const width = Math.abs(x2 - x1);
            const height = Math.abs(y2 - y1);
            const cx = left + width / 2;
            const cy = top + height / 2;
            // Draw fill
            ctx.globalAlpha = 0.1;
            ctx.fillStyle = '#fc7432';
            ctx.beginPath();
            ctx.ellipse(cx, cy, width / 2, height / 2, 0, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
            // Draw stroke
            ctx.beginPath();
            ctx.ellipse(cx, cy, width / 2, height / 2, 0, 0, Math.PI * 2);
            ctx.stroke();
        } else if (state.activeTool === 'circle') {
            // Circle preview (radius from p1 to mouse)
            const radius = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));
            ctx.beginPath();
            ctx.arc(x1, y1, radius, 0, Math.PI * 2);
            ctx.stroke();
        } else if (state.activeTool === 'gann_fan' || state.activeTool === 'gann_box') {
            // Gann preview
            if (state.activeTool === 'gann_fan') {
                // Draw fan lines from p1 toward p2 at standard angles
                const dx = x2 - x1;
                const dy = y2 - y1;
                for (const angle of DEFAULT_GANN_ANGLES) {
                    const angleDir = { x: dx, y: dy * angle.ratio };
                    const length = Math.sqrt(angleDir.x * angleDir.x + angleDir.y * angleDir.y);
                    if (length < 0.001) continue;
                    const dirX = angleDir.x / length;
                    const dirY = angleDir.y / length;
                    // Extend to edge
                    let t = 10000;
                    if (Math.abs(dirX) > 0.001) t = Math.min(t, dirX > 0 ? (plotRight - x1) / dirX : (plotLeft - x1) / dirX);
                    if (Math.abs(dirY) > 0.001) t = Math.min(t, dirY > 0 ? (plotBottom - y1) / dirY : (plotTop - y1) / dirY);
                    const endX = x1 + dirX * Math.max(t, 0);
                    const endY = y1 + dirY * Math.max(t, 0);
                    ctx.strokeStyle = angle.color;
                    ctx.globalAlpha = 0.6;
                    ctx.beginPath();
                    ctx.moveTo(x1, y1);
                    ctx.lineTo(endX, endY);
                    ctx.stroke();
                }
                ctx.globalAlpha = 1;
                ctx.strokeStyle = '#fc7432';
            } else {
                // Gann Box preview
                const left = Math.min(x1, x2);
                const top = Math.min(y1, y2);
                const width = Math.abs(x2 - x1);
                const height = Math.abs(y2 - y1);
                ctx.beginPath();
                ctx.rect(left, top, width, height);
                ctx.stroke();
                // Draw diagonal
                ctx.beginPath();
                ctx.moveTo(left, top + height);
                ctx.lineTo(left + width, top);
                ctx.stroke();
            }
        } else if (state.activeTool === 'long_position' || state.activeTool === 'short_position') {
            // Position preview with entry, target, and stop zones
            const isLong = state.activeTool === 'long_position';
            const entryPrice = state.pendingPoint.price;
            const mousePrice = rs.yToValue(currentMouseY);

            // Calculate default target/stop based on 2:1 R:R and drag distance
            const priceMove = Math.abs(mousePrice - entryPrice);
            const risk = priceMove > 0 ? priceMove : entryPrice * 0.02; // Default 2% if no drag
            const targetPrice = isLong ? entryPrice + risk * 2 : entryPrice - risk * 2;
            const stopPrice = isLong ? entryPrice - risk : entryPrice + risk;

            const left = Math.min(x1, x2);
            const width = Math.abs(x2 - x1) || 100;

            const entryY = y1;
            const targetY = rs.snapY(rs.valueToY(targetPrice));
            const stopY = rs.snapY(rs.valueToY(stopPrice));

            // Draw profit zone (green)
            ctx.globalAlpha = 0.2;
            ctx.fillStyle = '#26a69a';
            const profitTop = isLong ? targetY : entryY;
            const profitBottom = isLong ? entryY : targetY;
            ctx.fillRect(left, Math.min(profitTop, profitBottom), width, Math.abs(profitBottom - profitTop));

            // Draw loss zone (red)
            ctx.fillStyle = '#ef5350';
            const lossTop = isLong ? entryY : stopY;
            const lossBottom = isLong ? stopY : entryY;
            ctx.fillRect(left, Math.min(lossTop, lossBottom), width, Math.abs(lossBottom - lossTop));
            ctx.globalAlpha = 1;

            // Draw entry line
            ctx.strokeStyle = '#fc7432';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(left, entryY);
            ctx.lineTo(left + width, entryY);
            ctx.stroke();

            // Draw target line (dashed)
            ctx.strokeStyle = '#26a69a';
            ctx.setLineDash([5, 3]);
            ctx.beginPath();
            ctx.moveTo(left, targetY);
            ctx.lineTo(left + width, targetY);
            ctx.stroke();

            // Draw stop line (dashed)
            ctx.strokeStyle = '#ef5350';
            ctx.beginPath();
            ctx.moveTo(left, stopY);
            ctx.lineTo(left + width, stopY);
            ctx.stroke();
            ctx.setLineDash([4, 4]);

            // Labels
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = '#fc7432';
            ctx.fillText(`Entry: ${entryPrice.toFixed(2)}`, left + 5, entryY - 10);
            ctx.fillStyle = '#26a69a';
            ctx.fillText(`TP: ${targetPrice.toFixed(2)}`, left + 5, targetY);
            ctx.fillStyle = '#ef5350';
            ctx.fillText(`SL: ${stopPrice.toFixed(2)}`, left + 5, stopY);

            // R:R ratio
            ctx.font = 'bold 11px sans-serif';
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            const ratioText = 'R:R 2:1';
            const badgeY = Math.min(entryY, targetY, stopY) - 20;
            ctx.fillStyle = isLong ? '#26a69a' : '#ef5350';
            ctx.beginPath();
            ctx.roundRect(left + width / 2 - 25, badgeY - 8, 50, 16, 4);
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.fillText(ratioText, left + width / 2, badgeY);
        } else {
            // Default: simple line segment
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
        }

        // Draw endpoint handles
        ctx.setLineDash([]);
        ctx.fillStyle = '#fc7432';
        ctx.beginPath();
        ctx.arc(x1, y1, 4, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.arc(x2, y2, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.setLineDash([]);
    };

    // Render pending pattern points during multi-point creation
    const renderPendingPattern = (ctx: CanvasRenderingContext2D, rs: PluginRenderState) => {
        if (state.pendingPatternPoints.length === 0) return;

        const toolType = state.activeTool as PatternType;
        const requiredPoints = PATTERN_POINT_COUNTS[toolType];
        const labels = PATTERN_LABELS[toolType] || [];

        if (!requiredPoints) return;

        // Convert all placed points to screen coords
        const screenPoints = state.pendingPatternPoints.map(p => ({
            x: rs.snapX(rs.timeToX(p.time)),
            y: rs.snapY(rs.valueToY(p.price)),
        }));

        // Current mouse position for next point preview (use constrained if shift pressed)
        const mouseX = rs.snapX(constrainedMouseX);
        const mouseY = rs.snapY(constrainedMouseY);


        ctx.strokeStyle = '#fc7432';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Draw optional fill for closed patterns (3+ points)
        if (screenPoints.length >= 3) {
            ctx.globalAlpha = 0.05;
            ctx.fillStyle = '#fc7432';
            ctx.beginPath();
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
            for (let i = 1; i < screenPoints.length; i++) {
                ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
            }
            ctx.closePath();
            ctx.fill();
            ctx.globalAlpha = 1;
        }

        // Draw solid lines between placed points
        if (screenPoints.length >= 1) {
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
            for (let i = 1; i < screenPoints.length; i++) {
                ctx.lineTo(screenPoints[i].x, screenPoints[i].y);
            }
            ctx.stroke();
        }

        // Draw dashed preview line to mouse (next point)
        if (screenPoints.length > 0 && screenPoints.length < requiredPoints) {
            const lastPoint = screenPoints[screenPoints.length - 1];
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(lastPoint.x, lastPoint.y);
            ctx.lineTo(mouseX, mouseY);
            ctx.stroke();
        }

        // Draw point handles and labels
        ctx.setLineDash([]);
        ctx.font = 'bold 11px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';

        for (let i = 0; i < screenPoints.length; i++) {
            const { x, y } = screenPoints[i];
            const label = labels[i] || (i + 1).toString();

            // Draw handle
            ctx.fillStyle = '#fc7432';
            ctx.beginPath();
            ctx.arc(x, y, 5, 0, Math.PI * 2);
            ctx.fill();

            // Draw label above
            ctx.fillStyle = '#fc7432';
            ctx.fillText(label, x, y - 8);
        }

        // Draw preview handle at mouse position
        if (screenPoints.length < requiredPoints) {
            const nextLabel = labels[screenPoints.length] || (screenPoints.length + 1).toString();
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = '#fc7432';
            ctx.beginPath();
            ctx.arc(mouseX, mouseY, 5, 0, Math.PI * 2);
            ctx.fill();
            ctx.fillText(nextLabel, mouseX, mouseY - 8);
            ctx.globalAlpha = 1;
        }

        // Show progress label
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillStyle = '#fc7432';
        ctx.fillText(`Point ${screenPoints.length + 1} of ${requiredPoints}`, mouseX + 15, mouseY + 5);
    };

    // Render Fibonacci object (retracement, extension)
    const renderFib = (ctx: CanvasRenderingContext2D, fib: DrawingFib, rs: PluginRenderState) => {
        const y1 = rs.valueToY(fib.p1.price);
        const y2 = rs.valueToY(fib.p2.price);
        const priceRange = fib.p2.price - fib.p1.price;
        const isSelected = state.selectedFibId === fib.id;
        const isHovered = state.hoveredFibId === fib.id;

        const plotLeft = rs.plotRect.x;
        const plotRight = rs.plotRect.x + rs.plotRect.width;
        const x1 = rs.timeToX(fib.p1.time);
        const x2 = rs.timeToX(fib.p2.time);

        // Special rendering for statistical channels (regression-trend, std-dev-channel)
        if (fib.regressionData && (fib.type === 'regression-trend' || fib.type === 'std-dev-channel')) {
            const { slope, intercept, stdDev, dataPointCount, startTime, endTime } = fib.regressionData;

            // Render regression line and std dev bands across the channel's time range
            const channelStartX = Math.min(x1, x2);
            const channelEndX = Math.max(x1, x2);

            // The regression was calculated with data points indexed 0 to (dataPointCount-1)
            // We need to map any time to its corresponding index in the regression
            const timeRange = endTime - startTime;
            const timeToIndex = (time: TimeMs) => {
                const timeFraction = (time - startTime) / timeRange;
                return timeFraction * (dataPointCount - 1);
            };

            // Get the times at the start and end of the channel
            const channelStartTime = Math.min(fib.p1.time, fib.p2.time);
            const channelEndTime = Math.max(fib.p1.time, fib.p2.time);

            // Calculate indices for start and end points
            const startIdx = timeToIndex(channelStartTime);
            const endIdx = timeToIndex(channelEndTime);

            // Draw each level (std dev bands)
            for (const level of fib.levels) {
                const stdDevMultiplier = level.ratio; // ratio represents std dev multiplier (-3, -2, -1, 0, 1, 2, 3)
                const offset = stdDevMultiplier * stdDev;

                // Calculate prices at start and end using the regression formula
                const startPrice = intercept + slope * startIdx + offset;
                const endPrice = intercept + slope * endIdx + offset;

                const startY = rs.snapY(rs.valueToY(startPrice));
                const endY = rs.snapY(rs.valueToY(endPrice));

                // Set line style
                ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : level.color;
                ctx.lineWidth = level.width || 1;
                if (level.dash) {
                    ctx.setLineDash(level.dash);
                } else {
                    ctx.setLineDash([]);
                }

                // Draw line
                ctx.beginPath();
                ctx.moveTo(channelStartX, startY);
                ctx.lineTo(channelEndX, endY);
                ctx.stroke();

                // Draw label if requested
                if (level.showLabel) {
                    const labelText = stdDevMultiplier === 0 ? 'Mean' : `${stdDevMultiplier > 0 ? '+' : ''}${stdDevMultiplier}σ`;
                    ctx.fillStyle = level.color;
                    ctx.font = '11px sans-serif';
                    ctx.fillText(labelText, channelEndX + 5, endY);
                }
            }

            ctx.setLineDash([]);

            // Draw selection handles
            if (isSelected) {
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#2962ff';
                ctx.lineWidth = 2;

                ctx.beginPath();
                ctx.arc(x1, y1, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(x2, y2, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }

            return; // Skip standard fib rendering
        }

        // Special rendering for Flat Top/Bottom Channel
        if (fib.type === 'flat-top-bottom') {
            const isFlatTop = fib.p2.price < fib.p1.price; // Descending = flat top

            // P1 defines the horizontal line price
            const horizontalPrice = fib.p1.price;
            const horizontalY = rs.snapY(rs.valueToY(horizontalPrice));

            // Draw horizontal line (extends across visible range)
            ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : '#787b86';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(plotLeft, horizontalY);
            ctx.lineTo(plotRight, horizontalY);
            ctx.stroke();

            // Draw sloped trendline from P1 to P2 and extend
            const slope = (fib.p2.price - fib.p1.price) / (fib.p2.time - fib.p1.time);

            // Calculate where the sloped line intersects the plot boundaries
            const leftTime = rs.xToTime(plotLeft);
            const rightTime = rs.xToTime(plotRight);

            const leftPrice = fib.p1.price + slope * (leftTime - fib.p1.time);
            const rightPrice = fib.p1.price + slope * (rightTime - fib.p1.time);

            const leftY = rs.snapY(rs.valueToY(leftPrice));
            const rightY = rs.snapY(rs.valueToY(rightPrice));

            ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : '#787b86';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(plotLeft, leftY);
            ctx.lineTo(plotRight, rightY);
            ctx.stroke();

            // Optional: Fill between lines
            if (fib.showBackground) {
                ctx.globalAlpha = 0.08;
                ctx.fillStyle = fib.backgroundColor;
                ctx.beginPath();
                ctx.moveTo(plotLeft, horizontalY);
                ctx.lineTo(plotRight, horizontalY);
                ctx.lineTo(plotRight, rightY);
                ctx.lineTo(plotLeft, leftY);
                ctx.closePath();
                ctx.fill();
                ctx.globalAlpha = 1;
            }

            // Draw selection handles
            if (isSelected) {
                ctx.fillStyle = '#ffffff';
                ctx.strokeStyle = '#787b86';
                ctx.lineWidth = 2;

                ctx.beginPath();
                ctx.arc(x1, y1, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();

                ctx.beginPath();
                ctx.arc(x2, y2, HANDLE_RADIUS, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }

            return; // Skip standard fib rendering
        }

        // Special rendering for Disjoint Channel (two independent trendlines)
        if (fib.type === 'disjoint-channel') {
            // Always render Line 1 (P1→P2) if we have p1 and p2
            const slope1 = (fib.p2.price - fib.p1.price) / (fib.p2.time - fib.p1.time);

            // Calculate line 1 positions across visible range
            const leftTime = rs.xToTime(plotLeft);
            const rightTime = rs.xToTime(plotRight);

            const line1LeftPrice = fib.p1.price + slope1 * (leftTime - fib.p1.time);
            const line1RightPrice = fib.p1.price + slope1 * (rightTime - fib.p1.time);

            const line1LeftY = rs.snapY(rs.valueToY(line1LeftPrice));
            const line1RightY = rs.snapY(rs.valueToY(line1RightPrice));

            // Draw Line 1 (always visible)
            ctx.strokeStyle = isSelected || isHovered ? '#fc7432' : '#787b86';
            ctx.lineWidth = 2;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(plotLeft, line1LeftY);
            ctx.lineTo(plotRight, line1RightY);
            ctx.stroke();

            // If we have p4, render Line 2
            if (fib.p4 && fib.p3) {
                const slope2 = (fib.p4.price - fib.p3.price) / (fib.p4.time - fib.p3.time);

                const line2LeftPrice = fib.p3.price + slope2 * (leftTime - fib.p3.time);
                const line2RightPrice = fib.p3.price + slope2 * (rightTime - fib.p3.time);

                const line2LeftY = rs.snapY(rs.valueToY(line2LeftPrice));
                const line2RightY = rs.snapY(rs.valueToY(line2RightPrice));

                // Draw Line 2
                ctx.beginPath();
                ctx.moveTo(plotLeft, line2LeftY);
                ctx.lineTo(plotRight, line2RightY);
                ctx.stroke();

                // Optional: Fill between lines
                if (fib.showBackground) {
                    ctx.globalAlpha = 0.08;
                    ctx.fillStyle = fib.backgroundColor;
                    ctx.beginPath();
                    ctx.moveTo(plotLeft, line1LeftY);
                    ctx.lineTo(plotRight, line1RightY);
                    ctx.lineTo(plotRight, line2RightY);
                    ctx.lineTo(plotLeft, line2LeftY);
                    ctx.closePath();
                    ctx.fill();
                    ctx.globalAlpha = 1;
                }

                // Draw all 4 selection handles
                if (isSelected) {
                    ctx.fillStyle = '#ffffff';
                    ctx.strokeStyle = '#787b86';
                    ctx.lineWidth = 2;

                    const pts = [
                        { x: rs.timeToX(fib.p1.time), y: rs.valueToY(fib.p1.price) },
                        { x: rs.timeToX(fib.p2.time), y: rs.valueToY(fib.p2.price) },
                        { x: rs.timeToX(fib.p3.time), y: rs.valueToY(fib.p3.price) },
                        { x: rs.timeToX(fib.p4.time), y: rs.valueToY(fib.p4.price) },
                    ];

                    pts.forEach(pt => {
                        ctx.beginPath();
                        ctx.arc(pt.x, pt.y, HANDLE_RADIUS, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.stroke();
                    });
                }
            } else if (fib.p3) {
                // We have p3 but not p4 yet (during drawing-p4 mode)
                // Just show P3 as a dot
                const x3 = rs.timeToX(fib.p3.time);
                const y3 = rs.valueToY(fib.p3.price);

                ctx.fillStyle = '#fc7432';
                ctx.strokeStyle = '#ffffff';
                ctx.lineWidth = 2;
                ctx.beginPath();
                ctx.arc(x3, y3, 6, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
            }
            // If only p1-p2 (no p3 yet), we already drew line 1 above

            return; // Skip standard fib rendering
        }
        // Sort levels by ratio for proper fill ordering
        const sortedLevels = [...fib.levels].sort((a, b) => a.ratio - b.ratio);

        // Draw background fills between adjacent levels
        if (fib.showBackground) {
            for (let i = 0; i < sortedLevels.length - 1; i++) {
                const level1 = sortedLevels[i];
                const level2 = sortedLevels[i + 1];

                const price1 = fib.p1.price + priceRange * level1.ratio;
                const price2 = fib.p1.price + priceRange * level2.ratio;
                const levelY1 = rs.valueToY(price1);
                const levelY2 = rs.valueToY(price2);

                // Skip if outside visible area
                if (Math.max(levelY1, levelY2) < rs.plotRect.y ||
                    Math.min(levelY1, levelY2) > rs.plotRect.y + rs.plotRect.height) continue;

                // Alternating fill opacity based on significance
                const isKeyZone = (level1.ratio >= 0.5 && level1.ratio <= 0.618) ||
                    (level2.ratio >= 0.5 && level2.ratio <= 0.618);
                const opacity = isKeyZone ? 0.08 : 0.04;

                ctx.globalAlpha = opacity;
                ctx.fillStyle = fib.backgroundColor;
                ctx.fillRect(plotLeft, Math.min(levelY1, levelY2),
                    plotRight - plotLeft, Math.abs(levelY2 - levelY1));
            }
            ctx.globalAlpha = 1;
        }

        // Draw anchor trend line (diagonal line from p1 to p2)
        ctx.strokeStyle = isSelected ? '#fc7432' : 'rgba(120, 123, 134, 0.5)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
        ctx.lineTo(rs.snapX(x2), rs.snapY(y2));
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw each level
        for (const level of fib.levels) {
            const levelPrice = fib.p1.price + priceRange * level.ratio;
            const levelY = rs.snapY(rs.valueToY(levelPrice));

            // Skip if completely outside plot area
            if (levelY < rs.plotRect.y - 20 || levelY > rs.plotRect.y + rs.plotRect.height + 20) continue;

            // Key levels (0.5, 0.618) get thicker lines
            const isKeyLevel = level.ratio === 0.5 || level.ratio === 0.618;
            ctx.strokeStyle = level.color;
            ctx.lineWidth = (isSelected ? level.width + 0.5 : level.width) + (isKeyLevel ? 0.5 : 0);
            ctx.setLineDash(level.dash ?? []);

            ctx.beginPath();
            ctx.moveTo(plotLeft, levelY);
            ctx.lineTo(plotRight, levelY);
            ctx.stroke();

            // Draw level label
            if (level.showLabel) {
                // Clamp label Y to visible area
                const clampedY = Math.max(rs.plotRect.y + 12, Math.min(levelY - 3, rs.plotRect.y + rs.plotRect.height - 3));
                const labelText = `${(level.ratio * 100).toFixed(1)}% (${levelPrice.toFixed(2)})`;
                ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
                ctx.fillStyle = level.color;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.fillText(labelText, plotLeft + 8, clampedY);
            }
        }

        ctx.setLineDash([]);

        // Draw selection handles at anchor points
        if (isSelected) {
            ctx.fillStyle = '#fc7432';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;

            // Handle at p1
            ctx.beginPath();
            ctx.arc(rs.snapX(x1), rs.snapY(y1), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // Handle at p2
            ctx.beginPath();
            ctx.arc(rs.snapX(x2), rs.snapY(y2), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Hover highlight
        if (isHovered && !isSelected) {
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.5)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.strokeRect(plotLeft, Math.min(y1, y2), plotRight - plotLeft, Math.abs(y2 - y1));
            ctx.setLineDash([]);
        }
    };

    // Render 3-point Fib Extension (Trend-Based Extension)
    // A→B is the impulse move, C is where retracement ended
    // Extensions project from C using A→B distance
    const renderFibExtension = (ctx: CanvasRenderingContext2D, fib: DrawingFib, rs: PluginRenderState) => {
        if (!fib.p3) {
            // If p3 not set, fall back to regular retracement rendering
            renderFib(ctx, fib, rs);
            return;
        }

        const isSelected = state.selectedFibId === fib.id;
        const isHovered = state.hoveredFibId === fib.id;

        // Points
        const x1 = rs.timeToX(fib.p1.time);
        const y1 = rs.valueToY(fib.p1.price);
        const x2 = rs.timeToX(fib.p2.time);
        const y2 = rs.valueToY(fib.p2.price);
        const x3 = rs.timeToX(fib.p3.time);
        const y3 = rs.valueToY(fib.p3.price);

        const plotLeft = rs.plotRect.x;
        const plotRight = rs.plotRect.x + rs.plotRect.width;

        // Price range from A→B (the impulse move)
        const impulseRange = fib.p2.price - fib.p1.price;

        // Draw A→B→C connection lines (dashed)
        ctx.strokeStyle = isSelected ? '#fc7432' : 'rgba(120, 123, 134, 0.6)';
        ctx.lineWidth = isSelected ? 2 : 1;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
        ctx.lineTo(rs.snapX(x2), rs.snapY(y2));
        ctx.lineTo(rs.snapX(x3), rs.snapY(y3));
        ctx.stroke();
        ctx.setLineDash([]);

        // Draw extension levels projected from C
        for (const level of fib.levels) {
            // Extensions project from C using A→B impulse range
            const levelPrice = fib.p3.price + impulseRange * level.ratio;
            const levelY = rs.snapY(rs.valueToY(levelPrice));

            // Skip if outside visible area
            if (levelY < rs.plotRect.y - 20 || levelY > rs.plotRect.y + rs.plotRect.height + 20) continue;

            const isKeyLevel = level.ratio === 1 || level.ratio === 1.618;
            ctx.strokeStyle = level.color;
            ctx.lineWidth = (isSelected ? level.width + 0.5 : level.width) + (isKeyLevel ? 0.5 : 0);
            ctx.setLineDash(level.dash ?? []);

            ctx.beginPath();
            ctx.moveTo(plotLeft, levelY);
            ctx.lineTo(plotRight, levelY);
            ctx.stroke();

            // Label
            if (level.showLabel) {
                const clampedY = Math.max(rs.plotRect.y + 12, Math.min(levelY - 3, rs.plotRect.y + rs.plotRect.height - 3));
                const labelText = `${(level.ratio * 100).toFixed(1)}% (${levelPrice.toFixed(2)})`;
                ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
                ctx.fillStyle = level.color;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'bottom';
                ctx.fillText(labelText, plotLeft + 8, clampedY);
            }
        }
        ctx.setLineDash([]);

        // Selection handles at all 3 points
        if (isSelected) {
            ctx.fillStyle = '#fc7432';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;

            // A
            ctx.beginPath();
            ctx.arc(rs.snapX(x1), rs.snapY(y1), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // B
            ctx.beginPath();
            ctx.arc(rs.snapX(x2), rs.snapY(y2), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            // C
            ctx.beginPath();
            ctx.arc(rs.snapX(x3), rs.snapY(y3), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Hover effect
        if (isHovered && !isSelected) {
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
            ctx.lineTo(rs.snapX(x2), rs.snapY(y2));
            ctx.lineTo(rs.snapX(x3), rs.snapY(y3));
            ctx.stroke();
            ctx.setLineDash([]);
        }
    };

    // Render Fib Channel (parallel diagonal lines)
    // p1→p2 defines the base trend line, p3 defines the channel width
    const renderFibChannel = (ctx: CanvasRenderingContext2D, fib: DrawingFib, rs: PluginRenderState) => {
        if (!fib.p3) {
            // If p3 not set, just draw p1→p2 line preview
            const x1 = rs.timeToX(fib.p1.time);
            const y1 = rs.valueToY(fib.p1.price);
            const x2 = rs.timeToX(fib.p2.time);
            const y2 = rs.valueToY(fib.p2.price);
            ctx.strokeStyle = '#fc7432';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
            ctx.lineTo(rs.snapX(x2), rs.snapY(y2));
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        const x1 = rs.timeToX(fib.p1.time);
        const y1 = rs.valueToY(fib.p1.price);
        const x2 = rs.timeToX(fib.p2.time);
        const y2 = rs.valueToY(fib.p2.price);
        const x3 = rs.timeToX(fib.p3.time);
        const y3 = rs.valueToY(fib.p3.price);
        const isSelected = state.selectedFibId === fib.id;
        const isHovered = state.hoveredFibId === fib.id;

        // ========================================================================
        // CALCULATE CHANNEL OFFSET IN DATA SPACE (price units) - NOT screen space
        // This ensures the channel is invariant to Y-axis scaling/zooming
        // ========================================================================

        // Time span of the base trend line
        const t1 = fib.p1.time;
        const t2 = fib.p2.time;
        const t3 = fib.p3.time;
        const timeDelta = t2 - t1;

        // Calculate the price on the base line at p3's time
        // Using linear interpolation: price = p1.price + slope * (t - t1)
        let channelHeightPrice: number;
        if (timeDelta === 0) {
            // Vertical base line - use horizontal distance
            channelHeightPrice = fib.p3.price - fib.p1.price;
        } else {
            const priceSlope = (fib.p2.price - fib.p1.price) / timeDelta;
            const basePriceAtT3 = fib.p1.price + priceSlope * (t3 - t1);
            channelHeightPrice = fib.p3.price - basePriceAtT3; // Price difference
        }

        // Draw each level as a parallel line offset from p1→p2 by price offset
        for (const level of fib.levels) {
            // Calculate price offset for this level
            const priceOffset = channelHeightPrice * level.ratio;

            // The level line has the same slope as base, just offset in price
            const lp1Price = fib.p1.price + priceOffset;
            const lp2Price = fib.p2.price + priceOffset;

            // Convert to screen coordinates
            const lx1 = rs.timeToX(fib.p1.time);
            const ly1 = rs.valueToY(lp1Price);
            const lx2 = rs.timeToX(fib.p2.time);
            const ly2 = rs.valueToY(lp2Price);

            const isKeyLevel = level.ratio === 0 || level.ratio === 1;
            ctx.strokeStyle = level.color;
            ctx.lineWidth = (isSelected ? level.width + 0.5 : level.width) + (isKeyLevel ? 0.5 : 0);
            ctx.setLineDash(level.dash ?? []);

            ctx.beginPath();
            ctx.moveTo(rs.snapX(lx1), rs.snapY(ly1));
            ctx.lineTo(rs.snapX(lx2), rs.snapY(ly2));
            ctx.stroke();

            // Label at end of line
            if (level.showLabel) {
                const labelText = `${(level.ratio * 100).toFixed(1)}%`;
                ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
                ctx.fillStyle = level.color;
                ctx.textAlign = 'left';
                ctx.textBaseline = 'middle';
                ctx.fillText(labelText, rs.snapX(lx2) + 5, rs.snapY(ly2));
            }
        }
        ctx.setLineDash([]);

        // Draw selection handles at all 3 points
        if (isSelected) {
            ctx.fillStyle = '#fc7432';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;

            ctx.beginPath();
            ctx.arc(rs.snapX(x1), rs.snapY(y1), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(rs.snapX(x2), rs.snapY(y2), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(rs.snapX(x3), rs.snapY(y3), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Hover highlight
        if (isHovered && !isSelected) {
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
            ctx.lineTo(rs.snapX(x2), rs.snapY(y2));
            ctx.stroke();
            ctx.setLineDash([]);
        }
    };

    // ========================================================================
    // Render Pitchfork (Andrews' Pitchfork)
    // p1 = pivot (apex), p2 and p3 = base points
    // Median line: from p1 through midpoint of p2-p3
    // Tines: parallel to median, starting from p2 and p3
    // ========================================================================
    const renderPitchfork = (ctx: CanvasRenderingContext2D, fib: DrawingFib, rs: PluginRenderState) => {
        if (!fib.p3) {
            // If p3 not set, just draw p1→p2 preview
            const x1 = rs.timeToX(fib.p1.time);
            const y1 = rs.valueToY(fib.p1.price);
            const x2 = rs.timeToX(fib.p2.time);
            const y2 = rs.valueToY(fib.p2.price);
            ctx.strokeStyle = '#fc7432';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
            ctx.lineTo(rs.snapX(x2), rs.snapY(y2));
            ctx.stroke();
            ctx.setLineDash([]);
            return;
        }

        const x1 = rs.timeToX(fib.p1.time);
        const y1 = rs.valueToY(fib.p1.price);
        const x2 = rs.timeToX(fib.p2.time);
        const y2 = rs.valueToY(fib.p2.price);
        const x3 = rs.timeToX(fib.p3.time);
        const y3 = rs.valueToY(fib.p3.price);
        const isSelected = state.selectedFibId === fib.id;
        const isHovered = state.hoveredFibId === fib.id;

        // Calculate midpoint of base (p2-p3)
        const midX = (x2 + x3) / 2;
        const midY = (y2 + y3) / 2;

        // Median line direction vector (from p1 toward midpoint)
        const dirX = midX - x1;
        const dirY = midY - y1;
        const dirLen = Math.hypot(dirX, dirY);

        if (dirLen === 0) return; // Degenerate case

        // Extend the lines to edge of chart
        const extendFactor = 10; // Extend well beyond visible area

        // Median line: from p1, through midpoint, extended
        const medEndX = x1 + dirX * extendFactor;
        const medEndY = y1 + dirY * extendFactor;

        // Draw median line (ratio 0 = median)
        const medianLevel = fib.levels.find(l => l.ratio === 0) || { color: '#787b86', width: 2, dash: undefined };
        ctx.strokeStyle = medianLevel.color;
        ctx.lineWidth = isSelected ? medianLevel.width + 0.5 : medianLevel.width;
        ctx.setLineDash(medianLevel.dash || []);
        ctx.beginPath();
        ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
        ctx.lineTo(rs.snapX(medEndX), rs.snapY(medEndY));
        ctx.stroke();

        // Upper tine: from p2, parallel to median
        const upperLevel = fib.levels.find(l => l.ratio === 1) || { color: '#787b86', width: 2, dash: undefined };
        const upperEndX = x2 + dirX * extendFactor;
        const upperEndY = y2 + dirY * extendFactor;
        ctx.strokeStyle = upperLevel.color;
        ctx.lineWidth = isSelected ? upperLevel.width + 0.5 : upperLevel.width;
        ctx.setLineDash(upperLevel.dash || []);
        ctx.beginPath();
        ctx.moveTo(rs.snapX(x2), rs.snapY(y2));
        ctx.lineTo(rs.snapX(upperEndX), rs.snapY(upperEndY));
        ctx.stroke();

        // Lower tine: from p3, parallel to median
        const lowerEndX = x3 + dirX * extendFactor;
        const lowerEndY = y3 + dirY * extendFactor;
        ctx.beginPath();
        ctx.moveTo(rs.snapX(x3), rs.snapY(y3));
        ctx.lineTo(rs.snapX(lowerEndX), rs.snapY(lowerEndY));
        ctx.stroke();

        // Draw inner levels (0.25, 0.5, 0.75) as interpolated lines
        for (const level of fib.levels) {
            if (level.ratio === 0 || level.ratio === 1) continue; // Already drew median and outer

            // Interpolate between median and tines
            // At ratio 0.5, we're at the median; at 0/1 we're at tines
            // Actually for pitchfork, inner levels are between median and tines
            const t = level.ratio; // 0 = median side, 1 = outer side

            // Upper inner: interpolate between median starting point and p2
            const innerUpperStartX = x1 + (x2 - x1) * t;
            const innerUpperStartY = y1 + (y2 - y1) * t;
            const innerUpperEndX = innerUpperStartX + dirX * extendFactor;
            const innerUpperEndY = innerUpperStartY + dirY * extendFactor;

            // Lower inner: interpolate between median starting point and p3
            const innerLowerStartX = x1 + (x3 - x1) * t;
            const innerLowerStartY = y1 + (y3 - y1) * t;
            const innerLowerEndX = innerLowerStartX + dirX * extendFactor;
            const innerLowerEndY = innerLowerStartY + dirY * extendFactor;

            ctx.strokeStyle = level.color;
            ctx.lineWidth = level.width;
            ctx.setLineDash(level.dash || []);

            ctx.beginPath();
            ctx.moveTo(rs.snapX(innerUpperStartX), rs.snapY(innerUpperStartY));
            ctx.lineTo(rs.snapX(innerUpperEndX), rs.snapY(innerUpperEndY));
            ctx.stroke();

            ctx.beginPath();
            ctx.moveTo(rs.snapX(innerLowerStartX), rs.snapY(innerLowerStartY));
            ctx.lineTo(rs.snapX(innerLowerEndX), rs.snapY(innerLowerEndY));
            ctx.stroke();
        }
        ctx.setLineDash([]);

        // Draw selection handles at all 3 points
        if (isSelected) {
            ctx.fillStyle = '#fc7432';
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;

            ctx.beginPath();
            ctx.arc(rs.snapX(x1), rs.snapY(y1), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(rs.snapX(x2), rs.snapY(y2), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(rs.snapX(x3), rs.snapY(y3), HANDLE_RADIUS, 0, Math.PI * 2);
            ctx.fill();
            ctx.stroke();
        }

        // Hover highlight
        if (isHovered && !isSelected) {
            ctx.strokeStyle = 'rgba(252, 116, 50, 0.6)';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(rs.snapX(x1), rs.snapY(y1));
            ctx.lineTo(rs.snapX(midX), rs.snapY(midY));
            ctx.stroke();
            ctx.setLineDash([]);
        }
    };

    // Render pending Fib (while drawing first phase: p1 → cursor)
    const renderPendingFib = (ctx: CanvasRenderingContext2D, rs: PluginRenderState) => {
        if (!state.pendingPoint) return;

        const x1 = rs.snapX(rs.timeToX(state.pendingPoint.time));
        const y1 = rs.snapY(rs.valueToY(state.pendingPoint.price));
        const x2 = rs.snapX(constrainedMouseX);
        const y2 = rs.snapY(constrainedMouseY);


        // For Fib Extension and Channel: show a simple diagonal line during p1→p2 phase
        if (state.activeTool === 'fib-extension' || state.activeTool === 'fib-channel' || state.activeTool === 'parallel-channel') {
            ctx.strokeStyle = '#fc7432';
            ctx.lineWidth = 2;
            ctx.setLineDash([4, 4]);

            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();

            // Draw endpoints
            ctx.setLineDash([]);
            ctx.fillStyle = '#fc7432';
            ctx.beginPath();
            ctx.arc(x1, y1, 4, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            ctx.arc(x2, y2, 4, 0, Math.PI * 2);
            ctx.fill();

            // Label
            ctx.font = '11px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.fillStyle = '#fc7432';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            const label = state.activeTool === 'fib-extension' ? 'A → B (impulse)' : 'Base trend line';
            ctx.fillText(label, x1 + 10, y1 - 5);

            return;
        }

        // For Fib Retracement: show horizontal Fib levels preview
        const plotLeft = rs.plotRect.x;
        const plotRight = rs.plotRect.x + rs.plotRect.width;
        const priceRange = rs.yToValue(currentMouseY) - state.pendingPoint.price;

        for (const level of DEFAULT_FIB_LEVELS) {
            const levelPrice = state.pendingPoint.price + priceRange * level.ratio;
            const levelY = rs.snapY(rs.valueToY(levelPrice));

            if (levelY < rs.plotRect.y || levelY > rs.plotRect.y + rs.plotRect.height) continue;

            ctx.strokeStyle = level.color;
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.globalAlpha = 0.6;

            ctx.beginPath();
            ctx.moveTo(plotLeft, levelY);
            ctx.lineTo(plotRight, levelY);
            ctx.stroke();

            // Label
            const labelText = `${(level.ratio * 100).toFixed(1)}%`;
            ctx.font = '10px -apple-system, BlinkMacSystemFont, sans-serif';
            ctx.fillStyle = level.color;
            ctx.textAlign = 'left';
            ctx.textBaseline = 'bottom';
            ctx.fillText(labelText, plotLeft + 8, levelY - 2);
        }

        ctx.globalAlpha = 1;
        ctx.setLineDash([]);
    };

    // ========================================================================
    // Plugin Implementation
    // ========================================================================

    // Keyboard support with cleanup reference
    keydownHandler = (e: KeyboardEvent) => {
        if (isDestroyed) return;

        // Track shift key for angle constraints
        if (e.key === 'Shift') {
            isShiftPressed = true;
            if (state.mode === 'drawing' || state.mode === 'drawing-p3') {
                chartRef?.requestRender?.();
            }
        }

        if (e.key === 'Escape') {
            // Cancel ANY drawing mode (universal escape hatch)
            if (state.mode.startsWith('drawing')) {
                api.cancelDrawing();
                chartRef?.requestRender?.();
            } else if (state.mode === 'moving' || state.mode === 'editing') {
                // Cancel drag operation and REVERT to original position
                const line = state.lines.find(l => l.id === state.selectedLineId);
                if (line && state.dragStartData) {
                    line.p1 = { ...state.dragStartData.p1 };
                    line.p2 = { ...state.dragStartData.p2 };
                }

                const fib = state.fibs.find(f => f.id === state.selectedFibId);
                if (fib && state.dragStartData) {
                    fib.p1 = { ...state.dragStartData.p1 };
                    fib.p2 = { ...state.dragStartData.p2 };
                    // Also revert p3 for 3-point fibs
                    if (state.dragStartData.p3) {
                        fib.p3 = { ...state.dragStartData.p3 };
                    }
                }

                state.mode = 'idle';
                state.activeHandle = null;
                state.dragStartPoint = null;
                state.dragStartData = null;
                chartRef?.requestRender?.();
            } else if (state.selectedLineId || state.selectedFibId || state.selectedRectId || state.selectedEllipseId || state.selectedTextId || state.selectedMarkerId || state.selectedMeasureId || state.selectedGannId || state.selectedPatternId || state.selectedPositionId || state.selectedForecastId || state.selectedPathId || state.selectedArcId) {
                state.selectedLineId = null;
                state.selectedFibId = null;
                state.selectedRectId = null;
                state.selectedEllipseId = null;
                state.selectedTextId = null;
                state.selectedMarkerId = null;
                state.selectedMeasureId = null;
                state.selectedGannId = null;
                state.selectedPatternId = null;
                state.selectedPositionId = null;
                state.selectedForecastId = null;
                state.selectedPathId = null;
                state.selectedArcId = null;
                chartRef?.requestRender?.();
            }
        } else if (e.key === 'Delete' || e.key === 'Backspace') {
            if ((state.selectedLineId || state.selectedFibId || state.selectedRectId || state.selectedEllipseId || state.selectedTextId || state.selectedMarkerId || state.selectedMeasureId || state.selectedGannId || state.selectedPatternId || state.selectedPositionId || state.selectedForecastId || state.selectedPathId || state.selectedArcId) && state.mode === 'idle') {
                e.preventDefault();
                api.deleteSelected();
                chartRef?.requestRender?.();
            }
        }
    };

    // Keyup handler to release shift key
    keyupHandler = (e: KeyboardEvent) => {
        if (isDestroyed) return;
        if (e.key === 'Shift') {
            isShiftPressed = false;
            if (state.mode === 'drawing' || state.mode === 'drawing-p3') {
                chartRef?.requestRender?.();
            }
        }
    };

    const plugin: ChartPlugin<CanvasRenderingContext2D> = {
        onInit: (chart) => {
            chartRef = chart;

            // Add keyboard event listeners
            window.addEventListener('keydown', keydownHandler);
            window.addEventListener('keyup', keyupHandler);

            // Store keyup handler for cleanup
            const cleanup = () => {
                window.removeEventListener('keydown', keydownHandler);
                window.removeEventListener('keyup', keyupHandler);
            };

            // Make cleanup available
            (window as any).__drawingPluginCleanup = cleanup;
        },
        api,

        onRenderOverlay: (ctx, _rs) => {
            const rs = _rs as unknown as PluginRenderState;
            if (isDestroyed) return;
            lastRenderState = rs;

            // Skip rendering if drawings are hidden
            if (!drawingsVisible) return;

            // Render lines
            for (const line of state.lines) {
                renderLine(ctx, line, rs);
            }

            // Render rectangles
            for (const rect of state.rects) {
                renderRect(ctx, rect, rs);
            }

            // Render ellipses
            for (const ellipse of state.ellipses) {
                renderEllipse(ctx, ellipse, rs);
            }

            // Render texts
            for (const text of state.texts) {
                renderText(ctx, text, rs);
            }

            // Render crosses
            for (const cross of state.crosses) {
                renderCross(ctx, cross, rs);
            }

            // Render notes
            for (const note of state.notes) {
                renderNote(ctx, note, rs);
            }

            // Render callouts
            for (const callout of state.callouts) {
                renderCallout(ctx, callout, rs);
            }

            // Render markers
            for (const marker of state.markers) {
                renderMarker(ctx, marker, rs);
            }

            // Render measures
            for (const measure of state.measures) {
                renderMeasure(ctx, measure, rs);
            }

            // Render VWAP Bands
            for (const vwapBand of state.vwapBands) {
                renderVWAPBands(ctx, vwapBand, rs);
            }

            // Render Gann tools
            for (const gann of state.ganns) {
                renderGann(ctx, gann, rs);
            }

            // Render Patterns
            for (const pattern of state.patterns) {
                renderPattern(ctx, pattern, rs);
            }

            // Render Positions (Long/Short trade planning)
            for (const position of state.positions) {
                renderPosition(ctx, position, rs);
            }

            // Render Forecasts
            for (const forecast of state.forecasts) {
                renderForecast(ctx, forecast, rs);
            }

            // Render Paths
            for (const path of state.paths) {
                renderPath(ctx, path, rs);
            }

            // Render Arcs
            for (const arc of state.arcs) {
                renderArc(ctx, arc, rs);
            }

            // Render Fibonacci objects (use different renderers based on type)
            // Skip the pending Fib during 3/4-point drawing - let preview code handle it
            for (const fib of state.fibs) {
                if ((state.mode === 'drawing-p3' || state.mode === 'drawing-p4') && fib.id === state.pendingFibId) {
                    continue; // Skip - will be rendered by preview code below
                }

                if (fib.type === 'fib-channel' || fib.type === 'parallel-channel') {
                    renderFibChannel(ctx, fib, rs);
                } else if (fib.type === 'pitchfork') {
                    renderPitchfork(ctx, fib, rs);
                } else if (fib.type === 'fib-extension') {
                    renderFibExtension(ctx, fib, rs);
                } else {
                    renderFib(ctx, fib, rs);
                }
            }

            // Fib Time Zones - vertical lines at Fibonacci intervals
            if (state.fibTimeZones) {
                for (const ftz of state.fibTimeZones) {
                    const interval = ftz.endTime - ftz.startTime;
                    const fibs = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];
                    ctx.strokeStyle = ftz.color;
                    ctx.lineWidth = ftz.width;
                    for (const f of fibs) {
                        const t = ftz.startTime + interval * f;
                        const x = rs.timeToX(t);
                        ctx.beginPath();
                        ctx.moveTo(x, rs.plotRect.y);
                        ctx.lineTo(x, rs.plotRect.y + rs.plotRect.height);
                        ctx.stroke();
                    }
                }
            }

            // Fib Speed Fan - angled rays at Fib slope ratios
            if (state.fibSpeedFans) {
                for (const fsf of state.fibSpeedFans) {
                    const anchorX = rs.timeToX(fsf.anchor.time);
                    const anchorY = rs.valueToY(fsf.anchor.price);
                    const refX = rs.timeToX(fsf.reference.time);
                    const refY = rs.valueToY(fsf.reference.price);
                    const baseAngle = Math.atan2(refY - anchorY, refX - anchorX);

                    for (const level of fsf.levels) {
                        const angle = baseAngle * level.ratio;
                        const length = 2000;
                        const endX = anchorX + Math.cos(angle) * length;
                        const endY = anchorY + Math.sin(angle) * length;

                        ctx.strokeStyle = level.color;
                        ctx.lineWidth = level.width;
                        ctx.setLineDash(level.dash || []);
                        ctx.beginPath();
                        ctx.moveTo(anchorX, anchorY);
                        ctx.lineTo(endX, endY);
                        ctx.stroke();
                    }
                }
            }

            // Cyclic Lines - evenly spaced vertical lines
            if (state.cyclicLines) {
                for (const cl of state.cyclicLines) {
                    ctx.strokeStyle = cl.color;
                    ctx.lineWidth = cl.width;
                    ctx.setLineDash([]);

                    for (let i = 0; i < cl.count; i++) {
                        const time = cl.startTime + (cl.interval * i);
                        const x = rs.timeToX(time);
                        if (x >= rs.plotRect.x && x <= rs.plotRect.x + rs.plotRect.width) {
                            ctx.beginPath();
                            ctx.moveTo(x, rs.plotRect.y);
                            ctx.lineTo(x, rs.plotRect.y + rs.plotRect.height);
                            ctx.stroke();
                        }
                    }
                }
            }

            // Time Cycles - periodic time markers
            if (state.timeCycles) {
                for (const tc of state.timeCycles) {
                    ctx.strokeStyle = tc.color;
                    ctx.lineWidth = tc.width;
                    ctx.setLineDash([4, 4]);  // Dashed for cycles

                    for (let i = 0; i <= tc.cycles; i++) {
                        const time = tc.startTime + (tc.cycleLength * i);
                        const x = rs.timeToX(time);
                        if (x >= rs.plotRect.x && x <= rs.plotRect.x + rs.plotRect.width) {
                            ctx.beginPath();
                            ctx.moveTo(x, rs.plotRect.y);
                            ctx.lineTo(x, rs.plotRect.y + rs.plotRect.height);
                            ctx.stroke();
                        }
                    }
                    ctx.setLineDash([]);
                }
            }

            // Sine Line - sine wave overlay
            if (state.sineLines) {
                for (const sl of state.sineLines) {
                    const x1 = rs.timeToX(sl.startPoint.time);
                    const y1 = rs.valueToY(sl.startPoint.price);
                    const x2 = rs.timeToX(sl.endPoint.time);
                    const y2 = rs.valueToY(sl.endPoint.price);
                    const length = Math.sqrt(Math.pow(x2 - x1, 2) + Math.pow(y2 - y1, 2));

                    ctx.strokeStyle = sl.color;
                    ctx.lineWidth = sl.width;
                    ctx.beginPath();

                    const steps = 100;
                    for (let i = 0; i <= steps; i++) {
                        const t = i / steps;
                        const baseX = x1 + (x2 - x1) * t;
                        const baseY = y1 + (y2 - y1) * t;
                        const wave = Math.sin(t * Math.PI * 2 * sl.frequency) * sl.amplitude;
                        const angle = Math.atan2(y2 - y1, x2 - x1);
                        const offsetX = baseX - Math.sin(angle) * wave;
                        const offsetY = baseY + Math.cos(angle) * wave;

                        if (i === 0) ctx.moveTo(offsetX, offsetY);
                        else ctx.lineTo(offsetX, offsetY);
                    }
                    ctx.stroke();
                }
            }

            // Fibonacci Spiral - golden spiral geometry
            if (state.fibSpirals) {
                const PHI = 1.618033988749;  // Golden ratio
                for (const fs of state.fibSpirals) {
                    const centerX = rs.timeToX(fs.center.time);
                    const centerY = rs.valueToY(fs.center.price);

                    ctx.strokeStyle = fs.color;
                    ctx.lineWidth = fs.width;
                    ctx.beginPath();

                    // Draw spiral using Fibonacci sequence
                    let radius = fs.startRadius;
                    let angle = 0;
                    const angleIncrement = fs.direction === 'clockwise' ? -0.1 : 0.1;
                    const spirals = 3;  // Number of full rotations

                    for (let i = 0; i < spirals * Math.PI * 2 / Math.abs(angleIncrement); i++) {
                        const x = centerX + radius * Math.cos(angle);
                        const y = centerY + radius * Math.sin(angle);

                        if (i === 0) ctx.moveTo(x, y);
                        else ctx.lineTo(x, y);

                        angle += angleIncrement;
                        radius *= Math.pow(PHI, Math.abs(angleIncrement) / (Math.PI / 2));
                    }
                    ctx.stroke();
                }
            }

            // Render pending drawings
            if (state.mode === 'drawing' && state.pendingPoint) {
                if (state.activeTool === 'rectangle') {
                    // Pending rectangle preview
                    const x1 = rs.snapX(rs.timeToX(state.pendingPoint.time));
                    const y1 = rs.snapY(rs.valueToY(state.pendingPoint.price));
                    const x2 = rs.snapX(currentMouseX);
                    const y2 = rs.snapY(currentMouseY);
                    const left = Math.min(x1, x2);
                    const top = Math.min(y1, y2);
                    const width = Math.abs(x2 - x1);
                    const height = Math.abs(y2 - y1);

                    ctx.globalAlpha = 0.25;
                    ctx.fillStyle = '#4a90d9';
                    ctx.fillRect(left, top, width, height);
                    ctx.globalAlpha = 1;
                    ctx.strokeStyle = '#fc7432';
                    ctx.lineWidth = 2;
                    ctx.setLineDash([4, 4]);
                    ctx.strokeRect(left, top, width, height);
                    ctx.setLineDash([]);
                } else if (state.activeTool === 'ellipse' || state.activeTool === 'circle') {
                    // Pending ellipse/circle preview
                    const x1 = rs.snapX(rs.timeToX(state.pendingPoint.time));
                    const y1 = rs.snapY(rs.valueToY(state.pendingPoint.price));
                    const x2 = rs.snapX(currentMouseX);
                    const y2 = rs.snapY(currentMouseY);

                    let centerX: number, centerY: number, radiusX: number, radiusY: number;

                    if (state.activeTool === 'circle') {
                        centerX = x1;
                        centerY = y1;
                        const radius = Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2);
                        radiusX = radius;
                        radiusY = radius;
                    } else {
                        const left = Math.min(x1, x2);
                        const top = Math.min(y1, y2);
                        const width = Math.abs(x2 - x1);
                        const height = Math.abs(y2 - y1);
                        centerX = left + width / 2;
                        centerY = top + height / 2;
                        radiusX = width / 2;
                        radiusY = height / 2;
                    }

                    if (radiusX > 0 && radiusY > 0) {
                        ctx.globalAlpha = 0.25;
                        ctx.fillStyle = '#e6a030';
                        ctx.beginPath();
                        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
                        ctx.fill();
                        ctx.globalAlpha = 1;
                        ctx.strokeStyle = '#fc7432';
                        ctx.lineWidth = 2;
                        ctx.setLineDash([4, 4]);
                        ctx.beginPath();
                        ctx.ellipse(centerX, centerY, radiusX, radiusY, 0, 0, Math.PI * 2);
                        ctx.stroke();
                        ctx.setLineDash([]);
                    }
                } else if (state.activeTool === 'fib-retracement' || state.activeTool === 'fib-extension' || state.activeTool === 'fib-channel' || state.activeTool === 'parallel-channel' || state.activeTool === 'pitchfork') {
                    renderPendingFib(ctx, rs);
                } else if (state.activeTool === 'xabcd' || state.activeTool === 'abcd' || state.activeTool === 'triangle' || state.activeTool === 'head_shoulders') {
                    // Multi-point pattern preview
                    renderPendingPattern(ctx, rs);
                } else {
                    renderPending(ctx, rs);
                }
            }

            // Render preview for 3-point tool awaiting p3
            if (state.mode === 'drawing-p3' && state.pendingFibId) {
                const pendingFib = state.fibs.find(f => f.id === state.pendingFibId);
                if (pendingFib) {
                    // Temporarily set p3 to current mouse position for preview
                    const tempP3: DrawingPoint = {
                        time: rs.xToTime(currentMouseX),
                        price: rs.yToValue(currentMouseY),
                    };
                    const originalP3 = pendingFib.p3;
                    pendingFib.p3 = tempP3;

                    // Render with temporary p3
                    if (pendingFib.type === 'fib-channel' || pendingFib.type === 'parallel-channel') {
                        renderFibChannel(ctx, pendingFib, rs);
                    } else if (pendingFib.type === 'pitchfork') {
                        renderPitchfork(ctx, pendingFib, rs);
                    } else {
                        renderFibExtension(ctx, pendingFib, rs);
                    }

                    // Restore
                    pendingFib.p3 = originalP3;

                    // Draw a marker at current mouse position
                    ctx.fillStyle = '#fc7432';
                    ctx.beginPath();
                    ctx.arc(rs.snapX(currentMouseX), rs.snapY(currentMouseY), 5, 0, Math.PI * 2);
                    ctx.fill();
                }
            }

            // Render preview for 4-point tool awaiting p4 (disjoint channel)
            if (state.mode === 'drawing-p4' && state.pendingFibId) {
                const pendingFib = state.fibs.find(f => f.id === state.pendingFibId);
                if (pendingFib && pendingFib.type === 'disjoint-channel') {
                    // Temporarily set p4 to current mouse position for preview
                    const tempP4: DrawingPoint = {
                        time: rs.xToTime(currentMouseX),
                        price: rs.yToValue(currentMouseY),
                    };
                    const originalP4 = pendingFib.p4;
                    pendingFib.p4 = tempP4;

                    // Render with temporary p4
                    renderFib(ctx, pendingFib, rs);

                    // Restore
                    pendingFib.p4 = originalP4;

                    // Draw a marker at current mouse position
                    ctx.fillStyle = '#fc7432';
                    ctx.beginPath();
                    ctx.arc(rs.snapX(currentMouseX), rs.snapY(currentMouseY), 5, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        },

        onPointer: (event, _rs): boolean | void => {
            const rs = _rs as unknown as PluginRenderState;
            if (isDestroyed) return;

            // Safety mechanism: Release dragged objects if pointer leaves plot area
            if (!event.inPlot && (state.mode === 'moving' || state.mode === 'editing')) {
                state.mode = 'idle';
                state.activeHandle = null;
                state.dragStartPoint = null;
                state.dragStartData = null;
                chartRef?.requestRender?.();
                return;
            }

            currentMouseX = event.x;
            currentMouseY = event.y;

            // Calculate constrained coordinates if shift is pressed
            if (isShiftPressed && lastRenderState) {
                let x1, y1;

                // For patterns with pending points, constrain from last placed point
                if (state.pendingPatternPoints.length > 0) {
                    const lastPoint = state.pendingPatternPoints[state.pendingPatternPoints.length - 1];
                    x1 = lastRenderState.timeToX(lastPoint.time);
                    y1 = lastRenderState.valueToY(lastPoint.price);
                }
                // For regular 2-point tools, constrain from pending point
                else if (state.pendingPoint) {
                    x1 = lastRenderState.timeToX(state.pendingPoint.time);
                    y1 = lastRenderState.valueToY(state.pendingPoint.price);
                } else {
                    // No anchor point, use raw coords
                    constrainedMouseX = event.x;
                    constrainedMouseY = event.y;
                    lastRenderState = rs;
                    return;
                }

                const constrained = constrainToAngle(x1, y1, event.x, event.y);
                constrainedMouseX = constrained.x;
                constrainedMouseY = constrained.y;
            } else {
                // No constraint, use raw coords
                constrainedMouseX = event.x;
                constrainedMouseY = event.y;
            }

            lastRenderState = rs;

            // Handle mouse leave - reset cursor
            if (event.type === 'leave') {
                resetCursor();
                state.hoveredLineId = null;
                return;
            }

            // ================================================================
            // SELECT TOOL
            // ================================================================
            if (state.activeTool === 'select') {
                if (event.type === 'move') {
                    // Check if we should transition from 'selected' to 'moving'
                    if (state.mode === 'selected' && state.dragStartPoint) {
                        const dx = event.x - state.dragStartPoint.x;
                        const dy = event.y - state.dragStartPoint.y;
                        const distance = Math.sqrt(dx * dx + dy * dy);

                        // Only start moving if dragged more than 3 pixels
                        if (distance > 3) {
                            state.mode = 'moving';
                        } else {
                            // Haven't moved enough yet - stay in 'selected' mode, don't move
                            return;
                        }
                    }

                    // During drag, update the object position
                    if (state.mode === 'moving' || state.mode === 'editing') {
                        // Check which object type is selected and move it
                        if (state.selectedLineId) {
                            const line = state.lines.find(l => l.id === state.selectedLineId);
                            if (line && state.dragStartPoint && state.dragStartData) {
                                const currentPrice = rs.yToValue(event.y);

                                if (state.mode === 'moving') {
                                    // Move entire line
                                    const dx = event.x - state.dragStartPoint.x;
                                    const dy = event.y - state.dragStartPoint.y;

                                    // Convert screen delta to data delta using native xToTime
                                    const startX1 = rs.timeToX(state.dragStartData.p1.time);
                                    const startY1 = rs.valueToY(state.dragStartData.p1.price);
                                    const startX2 = rs.timeToX(state.dragStartData.p2.time);
                                    const startY2 = rs.valueToY(state.dragStartData.p2.price);

                                    // New screen positions
                                    const newX1 = startX1 + dx;
                                    const newY1 = startY1 + dy;
                                    const newX2 = startX2 + dx;
                                    const newY2 = startY2 + dy;

                                    // Use native xToTime for accurate conversion
                                    line.p1.time = rs.xToTime(newX1);
                                    line.p1.price = rs.yToValue(newY1);
                                    line.p2.time = rs.xToTime(newX2);
                                    line.p2.price = rs.yToValue(newY2);

                                } else if (state.mode === 'editing') {
                                    // Edit single endpoint using native xToTime
                                    const handle = state.activeHandle;
                                    const newTime = rs.xToTime(event.x);

                                    if (handle === 'p1') {
                                        line.p1.time = newTime;
                                        line.p1.price = currentPrice;
                                    } else if (handle === 'p2') {
                                        line.p2.time = newTime;
                                        line.p2.price = currentPrice;
                                    }
                                }
                            }
                            return;
                        } else if (state.selectedFibId) {
                            const selectedFib = state.fibs.find(f => f.id === state.selectedFibId);
                            if (selectedFib && (state.mode === 'moving' || state.mode === 'editing')) {
                                const dx = event.x - (state.dragStartPoint?.x ?? event.x);
                                const dy = event.y - (state.dragStartPoint?.y ?? event.y);

                                if (state.mode === 'moving' && state.dragStartData) {
                                    const startY1 = rs.valueToY(state.dragStartData.p1.price);
                                    const startY2 = rs.valueToY(state.dragStartData.p2.price);
                                    const startX1 = rs.timeToX(state.dragStartData.p1.time);
                                    const startX2 = rs.timeToX(state.dragStartData.p2.time);

                                    selectedFib.p1.time = rs.xToTime(startX1 + dx);
                                    selectedFib.p1.price = rs.yToValue(startY1 + dy);
                                    selectedFib.p2.time = rs.xToTime(startX2 + dx);
                                    selectedFib.p2.price = rs.yToValue(startY2 + dy);

                                    // Also move p3 for 3-point fibs
                                    if (selectedFib.p3 && state.dragStartData.p3) {
                                        const startX3 = rs.timeToX(state.dragStartData.p3.time);
                                        const startY3 = rs.valueToY(state.dragStartData.p3.price);
                                        selectedFib.p3.time = rs.xToTime(startX3 + dx);
                                        selectedFib.p3.price = rs.yToValue(startY3 + dy);
                                    }
                                    // Also move p4 for 4-point fibs (disjoint channel)
                                    if (selectedFib.p4 && state.dragStartData.p4) {
                                        const startX4 = rs.timeToX(state.dragStartData.p4.time);
                                        const startY4 = rs.valueToY(state.dragStartData.p4.price);
                                        selectedFib.p4.time = rs.xToTime(startX4 + dx);
                                        selectedFib.p4.price = rs.yToValue(startY4 + dy);
                                    }
                                } else if (state.mode === 'editing') {
                                    const currentPrice = rs.yToValue(event.y);
                                    const handle = state.activeHandle;
                                    const newTime = rs.xToTime(event.x);

                                    if (handle === 'p1') {
                                        selectedFib.p1.time = newTime;
                                        selectedFib.p1.price = currentPrice;
                                    } else if (handle === 'p2') {
                                        selectedFib.p2.time = newTime;
                                        selectedFib.p2.price = currentPrice;
                                    } else if (handle === 'p3' && selectedFib.p3) {
                                        selectedFib.p3.time = newTime;
                                        selectedFib.p3.price = currentPrice;
                                    } else if (handle === 'p4' && selectedFib.p4) {
                                        selectedFib.p4.time = newTime;
                                        selectedFib.p4.price = currentPrice;
                                    }
                                }
                            }
                        }

                    } else if (state.selectedRectId) {
                        const selectedRect = state.rects.find(r => r.id === state.selectedRectId);
                        if (selectedRect && state.dragStartPoint && state.dragStartData) {
                            const dx = event.x - (state.dragStartPoint?.x ?? event.x);
                            const dy = event.y - (state.dragStartPoint?.y ?? event.y);

                            if (state.mode === 'moving' && state.dragStartData) {
                                // Move entire rectangle
                                const startY1 = rs.valueToY(state.dragStartData.p1.price);
                                const startY2 = rs.valueToY(state.dragStartData.p2.price);
                                const startX1 = rs.timeToX(state.dragStartData.p1.time);
                                const startX2 = rs.timeToX(state.dragStartData.p2.time);

                                selectedRect.p1.time = rs.xToTime(startX1 + dx);
                                selectedRect.p1.price = rs.yToValue(startY1 + dy);
                                selectedRect.p2.time = rs.xToTime(startX2 + dx);
                                selectedRect.p2.price = rs.yToValue(startY2 + dy);
                            } else if (state.mode === 'editing' && state.dragStartData) {
                                // Resize rectangle - handle determines which corner
                                const handle = state.activeHandle;
                                const newTime = rs.xToTime(event.x);
                                const newPrice = rs.yToValue(event.y);

                                // p1 = top-left corner, p2 = bottom-right corner in data space
                                // But handles are mapped to screen corners, so we need to handle all 4
                                if (handle === 'p1') {
                                    // Top-left corner
                                    selectedRect.p1.time = newTime;
                                    selectedRect.p1.price = newPrice;
                                } else if (handle === 'p2') {
                                    // Top-right corner - change p2.time and p1.price
                                    selectedRect.p2.time = newTime;
                                    selectedRect.p1.price = newPrice;
                                } else if (handle === 'p3') {
                                    // Bottom-left corner - change p1.time and p2.price
                                    selectedRect.p1.time = newTime;
                                    selectedRect.p2.price = newPrice;
                                } else {
                                    // p4: Bottom-right corner
                                    selectedRect.p2.time = newTime;
                                    selectedRect.p2.price = newPrice;
                                }
                            }
                        } else if (state.selectedEllipseId) {
                            const selectedEllipse = state.ellipses.find(e => e.id === state.selectedEllipseId);
                            if (selectedEllipse && state.dragStartPoint && state.dragStartData) {
                                const dx = event.x - (state.dragStartPoint?.x ?? event.x);
                                const dy = event.y - (state.dragStartPoint?.y ?? event.y);

                                if (state.mode === 'moving' && state.dragStartData) {
                                    // Move entire ellipse
                                    const startY1 = rs.valueToY(state.dragStartData.p1.price);
                                    const startY2 = rs.valueToY(state.dragStartData.p2.price);
                                    const startX1 = rs.timeToX(state.dragStartData.p1.time);
                                    const startX2 = rs.timeToX(state.dragStartData.p2.time);

                                    selectedEllipse.p1.time = rs.xToTime(startX1 + dx);
                                    selectedEllipse.p1.price = rs.yToValue(startY1 + dy);
                                    selectedEllipse.p2.time = rs.xToTime(startX2 + dx);
                                    selectedEllipse.p2.price = rs.yToValue(startY2 + dy);
                                } else if (state.mode === 'editing' && state.dragStartData) {
                                    // Resize ellipse - move the dragged handle point
                                    const handle = state.activeHandle;
                                    const newTime = rs.xToTime(event.x);
                                    const newPrice = rs.yToValue(event.y);

                                    if (handle === 'p1') {
                                        selectedEllipse.p1.time = newTime;
                                        selectedEllipse.p1.price = newPrice;
                                    } else if (handle === 'p2') {
                                        selectedEllipse.p2.time = newTime;
                                        selectedEllipse.p2.price = newPrice;
                                    }
                                }
                            } else if (state.selectedTextId) {
                                const selectedText = state.texts.find(t => t.id === state.selectedTextId);
                                if (selectedText && state.mode === 'moving' && state.dragStartPoint && state.dragStartData) {
                                    const dx = event.x - (state.dragStartPoint?.x ?? event.x);
                                    const dy = event.y - (state.dragStartPoint?.y ?? event.y);

                                    const startX = rs.timeToX(state.dragStartData.p1.time);
                                    const startY = rs.valueToY(state.dragStartData.p1.price);

                                    selectedText.position.time = rs.xToTime(startX + dx);
                                    selectedText.position.price = rs.yToValue(startY + dy);
                                }
                            } else if (state.selectedCrossId) {
                                const selectedCross = state.crosses.find(c => c.id === state.selectedCrossId);
                                if (selectedCross && state.mode === 'moving') {
                                    selectedCross.time = rs.xToTime(event.x);
                                    selectedCross.price = rs.yToValue(event.y);
                                }
                            } else if (state.selectedNoteId) {
                                const selectedNote = state.notes.find(n => n.id === state.selectedNoteId);
                                if (selectedNote && state.mode === 'moving') {
                                    selectedNote.position.time = rs.xToTime(event.x);
                                    selectedNote.position.price = rs.yToValue(event.y);
                                }
                            } else if (state.selectedCalloutId) {
                                const selectedCallout = state.callouts.find(c => c.id === state.selectedCalloutId);
                                if (selectedCallout && state.mode === 'moving' && state.dragStartPoint) {
                                    const dx = event.x - state.dragStartPoint.x;
                                    const dy = event.y - state.dragStartPoint.y;
                                    // Move both text position and target position
                                    const textX = rs.timeToX(selectedCallout.textPosition.time) + dx;
                                    const textY = rs.valueToY(selectedCallout.textPosition.price) + dy;
                                    const targetX = rs.timeToX(selectedCallout.targetPosition.time) + dx;
                                    const targetY = rs.valueToY(selectedCallout.targetPosition.price) + dy;
                                    selectedCallout.textPosition.time = rs.xToTime(textX);
                                    selectedCallout.textPosition.price = rs.valueToY(textY);
                                    selectedCallout.targetPosition.time = rs.xToTime(targetX);
                                    selectedCallout.targetPosition.price = rs.valueToY(targetY);
                                    state.dragStartPoint = { x: event.x, y: event.y };
                                }
                            } else if (state.selectedMeasureId) {
                                const selectedMeasure = state.measures.find(m => m.id === state.selectedMeasureId);
                                if (selectedMeasure && (state.mode === 'moving' || state.mode === 'editing')) {
                                    const dx = event.x - (state.dragStartPoint?.x ?? event.x);
                                    const dy = event.y - (state.dragStartPoint?.y ?? event.y);

                                    if (state.mode === 'moving' && state.dragStartData) {
                                        const startY1 = rs.valueToY(state.dragStartData.p1.price);
                                        const startY2 = rs.valueToY(state.dragStartData.p2.price);
                                        const startX1 = rs.timeToX(state.dragStartData.p1.time);
                                        const startX2 = rs.timeToX(state.dragStartData.p2.time);

                                        selectedMeasure.p1.time = rs.xToTime(startX1 + dx);
                                        selectedMeasure.p1.price = rs.yToValue(startY1 + dy);
                                        selectedMeasure.p2.time = rs.xToTime(startX2 + dx);
                                        selectedMeasure.p2.price = rs.yToValue(startY2 + dy);
                                    } else if (state.mode === 'editing') {
                                        const handle = state.activeHandle;
                                        const newTime = rs.xToTime(event.x);
                                        const newPrice = rs.yToValue(event.y);

                                        if (handle === 'p1') {
                                            selectedMeasure.p1.time = newTime;
                                            selectedMeasure.p1.price = newPrice;
                                        } else if (handle === 'p2') {
                                            selectedMeasure.p2.time = newTime;
                                            selectedMeasure.p2.price = newPrice;
                                        }
                                    }
                                }
                            }
                        } else if (state.selectedGannId) {
                            const selectedGann = state.ganns.find(g => g.id === state.selectedGannId);
                            if (selectedGann && state.dragStartPoint && state.dragStartData) {
                                const dx = event.x - (state.dragStartPoint?.x ?? event.x);
                                const dy = event.y - (state.dragStartPoint?.y ?? event.y);

                                if (state.mode === 'moving' && state.dragStartData) {
                                    const startY1 = rs.valueToY(state.dragStartData.p1.price);
                                    const startY2 = rs.valueToY(state.dragStartData.p2.price);
                                    const startX1 = rs.timeToX(state.dragStartData.p1.time);
                                    const startX2 = rs.timeToX(state.dragStartData.p2.time);

                                    selectedGann.p1.time = rs.xToTime(startX1 + dx);
                                    selectedGann.p1.price = rs.yToValue(startY1 + dy);
                                    selectedGann.p2.time = rs.xToTime(startX2 + dx);
                                    selectedGann.p2.price = rs.yToValue(startY2 + dy);
                                } else if (state.mode === 'editing') {
                                    const handle = state.activeHandle;
                                    const newTime = rs.xToTime(event.x);
                                    const newPrice = rs.yToValue(event.y);

                                    if (handle === 'p1') {
                                        selectedGann.p1.time = newTime;
                                        selectedGann.p1.price = newPrice;
                                    } else if (handle === 'p2') {
                                        selectedGann.p2.time = newTime;
                                        selectedGann.p2.price = newPrice;
                                    }
                                }
                            }
                        }
                        return; // End of movement/editing logic
                    }

                    // Hover detection (only when not dragging)
                    const lineHit = event.inPlot ? findLineAtPoint(event.x, event.y, rs) : null;
                    const fibHit = event.inPlot ? findFibAtPoint(event.x, event.y, rs) : null;
                    const rectHit = event.inPlot ? findRectAtPoint(event.x, event.y, rs) : null;
                    const ellipseHit = event.inPlot ? findEllipseAtPoint(event.x, event.y, rs) : null;
                    const textHit = event.inPlot ? findTextAtPoint(event.x, event.y, rs) : null;
                    const markerHit = event.inPlot ? findMarkerAtPoint(event.x, event.y, rs) : null;
                    const measureHit = event.inPlot ? findMeasureAtPoint(event.x, event.y, rs) : null;
                    const gannHit = event.inPlot ? findGannAtPoint(event.x, event.y, rs) : null;
                    const patternHit = event.inPlot ? findPatternAtPoint(event.x, event.y, rs) : null;
                    const positionHit = event.inPlot ? findPositionAtPoint(event.x, event.y, rs) : null;

                    const newHoverLineId = lineHit?.line.id ?? null;
                    const newHoverFibId = fibHit?.fib.id ?? null;
                    const newHoverRectId = rectHit?.rect.id ?? null;
                    const newHoverEllipseId = ellipseHit?.ellipse.id ?? null;
                    const newHoverTextId = textHit?.text.id ?? null;
                    const newHoverMarkerId = markerHit?.marker.id ?? null;
                    const newHoverMeasureId = measureHit?.measure.id ?? null;
                    const newHoverGannId = gannHit?.gann.id ?? null;
                    const newHoverPatternId = patternHit?.pattern.id ?? null;
                    const newHoverPositionId = positionHit?.position.id ?? null;

                    if (newHoverLineId !== state.hoveredLineId ||
                        newHoverFibId !== state.hoveredFibId ||
                        newHoverRectId !== state.hoveredRectId ||
                        newHoverEllipseId !== state.hoveredEllipseId ||
                        newHoverTextId !== state.hoveredTextId ||
                        newHoverMarkerId !== state.hoveredMarkerId ||
                        newHoverMeasureId !== state.hoveredMeasureId ||
                        newHoverGannId !== state.hoveredGannId ||
                        newHoverPatternId !== state.hoveredPatternId ||
                        newHoverPositionId !== state.hoveredPositionId) {
                        state.hoveredLineId = newHoverLineId;
                        state.hoveredFibId = newHoverFibId;
                        state.hoveredRectId = newHoverRectId;
                        state.hoveredEllipseId = newHoverEllipseId;
                        state.hoveredTextId = newHoverTextId;
                        state.hoveredMarkerId = newHoverMarkerId;
                        state.hoveredMeasureId = newHoverMeasureId;
                        state.hoveredGannId = newHoverGannId;
                        state.hoveredPatternId = newHoverPatternId;
                        state.hoveredPositionId = newHoverPositionId;

                        // Update cursor
                        const hit = lineHit ?? fibHit ?? rectHit ?? ellipseHit ?? textHit ?? markerHit ?? measureHit ?? gannHit ?? patternHit ?? positionHit;
                        if (hit) {
                            if ('line' in hit && (hit.handle === 'p1' || hit.handle === 'p2')) {
                                setCursor('crosshair');
                            } else if ('fib' in hit && (hit.handle === 'p1' || hit.handle === 'p2' || hit.handle === 'p3')) {
                                setCursor('crosshair');
                            } else if ('rect' in hit && hit.handle !== 'body') {
                                setCursor('nwse-resize');
                            } else if ('ellipse' in hit && hit.handle !== 'body') {
                                setCursor('crosshair');
                            } else if ('measure' in hit && hit.handle !== 'body') {
                                setCursor('nwse-resize');
                            } else if ('gann' in hit && hit.handle !== 'body') {
                                setCursor('crosshair');
                            } else if ('pattern' in hit && hit.handle !== 'body') {
                                setCursor('crosshair');
                            } else if ('position' in hit && hit.handle !== 'body') {
                                setCursor('ew-resize');
                            } else {
                                setCursor('move');
                            }
                        } else {
                            resetCursor();
                        }
                    }
                    return; // Prevent fall-through to drawing tools
                } else if (event.type === 'down' && event.inPlot) {
                    // Check lines, then fibs, then rects, then ellipses, then texts
                    const lineHit = findLineAtPoint(event.x, event.y, rs);
                    const fibHit = findFibAtPoint(event.x, event.y, rs);
                    const rectHit = findRectAtPoint(event.x, event.y, rs);
                    const ellipseHit = findEllipseAtPoint(event.x, event.y, rs);
                    const textHit = findTextAtPoint(event.x, event.y, rs);
                    const markerHit = findMarkerAtPoint(event.x, event.y, rs);
                    const measureHit = findMeasureAtPoint(event.x, event.y, rs);
                    const gannHit = findGannAtPoint(event.x, event.y, rs);
                    const patternHit = findPatternAtPoint(event.x, event.y, rs);
                    const positionHit = findPositionAtPoint(event.x, event.y, rs);

                    // Eraser mode: delete clicked object immediately
                    if (eraserModeEnabled) {
                        if (lineHit) {
                            api.removeLine(lineHit.line.id);
                        } else if (fibHit) {
                            api.removeFib(fibHit.fib.id);
                        } else if (rectHit) {
                            api.removeRect(rectHit.rect.id);
                        } else if (ellipseHit) {
                            state.ellipses = state.ellipses.filter(e => e.id !== ellipseHit.ellipse.id);
                        } else if (textHit) {
                            state.texts = state.texts.filter(t => t.id !== textHit.text.id);
                        } else if (markerHit) {
                            state.markers = state.markers.filter(m => m.id !== markerHit.marker.id);
                        } else if (measureHit) {
                            state.measures = state.measures.filter(m => m.id !== measureHit.measure.id);
                        } else if (gannHit) {
                            state.ganns = state.ganns.filter(g => g.id !== gannHit.gann.id);
                        } else if (patternHit) {
                            state.patterns = state.patterns.filter(p => p.id !== patternHit.pattern.id);
                        } else if (positionHit) {
                            state.positions = state.positions.filter(p => p.id !== positionHit.position.id);
                        }
                        if (lineHit || fibHit || rectHit || ellipseHit || textHit || markerHit || measureHit || gannHit || patternHit || positionHit) {
                            chartRef?.requestRender?.();
                            return true;
                        }
                        return;
                    }

                    // Locked mode: prevent selection and editing
                    if (drawingsLocked) {
                        return;
                    }

                    if (lineHit) {
                        state.selectedLineId = lineHit.line.id;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.activeHandle = lineHit.handle;
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = {
                            p1: { ...lineHit.line.p1 },
                            p2: { ...lineHit.line.p2 },
                        };

                        if (lineHit.handle === 'body') {
                            state.mode = 'selected';  // Don't move yet - wait for drag threshold
                        } else {
                            state.mode = 'editing';   // Handles are immediately editable
                        }
                        return true;
                    } else if (fibHit) {
                        state.selectedFibId = fibHit.fib.id;
                        state.selectedLineId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.activeHandle = fibHit.handle;
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = {
                            p1: { ...fibHit.fib.p1 },
                            p2: { ...fibHit.fib.p2 },
                            p3: fibHit.fib.p3 ? { ...fibHit.fib.p3 } : undefined,
                        };

                        if (fibHit.handle === 'body') {
                            state.mode = 'selected';
                        } else {
                            state.mode = 'editing';
                        }
                        return true;
                    } else if (rectHit) {
                        state.selectedRectId = rectHit.rect.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.activeHandle = rectHit.handle as HandleType;
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = {
                            p1: { ...rectHit.rect.p1 },
                            p2: { ...rectHit.rect.p2 },
                        };

                        if (rectHit.handle === 'body') {
                            state.mode = 'selected';
                        } else {
                            state.mode = 'editing';
                        }
                        return true;
                    } else if (ellipseHit) {
                        state.selectedEllipseId = ellipseHit.ellipse.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.activeHandle = ellipseHit.handle as HandleType;
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = {
                            p1: { ...ellipseHit.ellipse.p1 },
                            p2: { ...ellipseHit.ellipse.p2 },
                        };

                        if (ellipseHit.handle === 'body') {
                            state.mode = 'selected';
                        } else {
                            state.mode = 'editing';
                        }
                        return true;
                    } else if (textHit) {
                        state.selectedTextId = textHit.text.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.activeHandle = 'body';
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = {
                            p1: { ...textHit.text.position },
                            p2: { ...textHit.text.position },
                        };
                        state.mode = 'selected';
                        return true;
                    }

                    // Check for cross
                    const crossAtPoint = findCrossAtPoint(event.x, event.y, rs);
                    if (crossAtPoint) {
                        state.selectedCrossId = crossAtPoint.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedNoteId = null;
                        state.selectedCalloutId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.mode = 'selected';
                        state.dragStartPoint = { x: event.x, y: event.y };
                        return true;
                    }

                    // Check for note
                    const noteAtPoint = findNoteAtPoint(event.x, event.y, rs);
                    if (noteAtPoint) {
                        state.selectedNoteId = noteAtPoint.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedCrossId = null;
                        state.selectedCalloutId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.mode = 'selected';
                        state.dragStartPoint = { x: event.x, y: event.y };
                        return true;
                    }

                    // Check for callout
                    const calloutAtPoint = findCalloutAtPoint(event.x, event.y, rs);
                    if (calloutAtPoint) {
                        state.selectedCalloutId = calloutAtPoint.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedCrossId = null;
                        state.selectedNoteId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.mode = 'selected';
                        state.dragStartPoint = { x: event.x, y: event.y };
                        return true;
                    }

                    if (markerHit) {
                        state.selectedMarkerId = markerHit.marker.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                        state.activeHandle = 'body';
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = { p1: { ...markerHit.marker.position }, p2: { ...markerHit.marker.position } };
                        state.mode = 'moving';
                        return true;
                    } else if (measureHit) {
                        state.selectedMeasureId = measureHit.measure.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedGannId = null;
                        state.activeHandle = measureHit.handle;
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = { p1: { ...measureHit.measure.p1 }, p2: { ...measureHit.measure.p2 } };
                        state.mode = measureHit.handle === 'body' ? 'moving' : 'editing';
                        return true;
                    } else if (gannHit) {
                        state.selectedGannId = gannHit.gann.id;
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.activeHandle = gannHit.handle;
                        state.dragStartPoint = { x: event.x, y: event.y };
                        state.dragStartData = { p1: { ...gannHit.gann.p1 }, p2: { ...gannHit.gann.p2 } };
                        state.mode = gannHit.handle === 'body' ? 'moving' : 'editing';
                        return true;
                    } else {
                        // Clicked empty space - deselect all
                        state.selectedLineId = null;
                        state.selectedFibId = null;
                        state.selectedRectId = null;
                        state.selectedEllipseId = null;
                        state.selectedTextId = null;
                        state.selectedMarkerId = null;
                        state.selectedMeasureId = null;
                        state.selectedGannId = null;
                    }
                    return; // Prevent fall-through to drawing tools
                }
            }
            if (event.type === 'up' && state.activeTool === 'select') {
                if (state.mode === 'moving' || state.mode === 'editing') {
                    // Check for text edit click (if moved less than 3 pixels)
                    if (state.selectedTextId && state.dragStartPoint) {
                        const dist = Math.sqrt(Math.pow(event.x - state.dragStartPoint.x, 2) + Math.pow(event.y - state.dragStartPoint.y, 2));
                        if (dist < 3) {
                            const textObj = state.texts.find(t => t.id === state.selectedTextId);
                            if (textObj) {
                                // Use timeout to let the click event finish
                                setTimeout(() => {
                                    const newContent = prompt('Edit text:', textObj.content);
                                    if (newContent !== null) {
                                        textObj.content = newContent;
                                        if (drawingsChangedCallback) drawingsChangedCallback();
                                        chartRef?.requestRender?.();
                                    }
                                }, 0);
                            }
                        }
                    }

                    state.mode = 'idle';
                    state.activeHandle = null;
                    state.dragStartPoint = null;
                    state.dragStartData = null;
                } else if (state.mode === 'selected') {
                    // Was selected but never dragged - just a click
                    // Keep selection but clear drag state
                    state.mode = 'idle';
                    state.activeHandle = null;
                    state.dragStartPoint = null;
                    state.dragStartData = null;
                }
                return; // Prevent fall-through to drawing tools
            }



            // ================================================================
            // DRAWING TOOLS
            // ================================================================
            // Skip drawing tools when in select mode
            if (state.activeTool === 'select') {
                return;
            }

            if (!event.inPlot) return;

            if (event.type === 'down') {
                const is3PointTool = state.activeTool === 'fib-extension' || state.activeTool === 'fib-channel' || state.activeTool === 'parallel-channel' || state.activeTool === 'pitchfork';

                if (state.mode === 'idle') {
                    const markerTools = ['marker', 'arrow_up', 'arrow_down', 'arrow_left', 'arrow_right', 'flag', 'pin', 'swing_high', 'swing_low', 'bos', 'choch', 'liquidity', 'invalidation'];
                    if (markerTools.includes(state.activeTool)) {
                        const point: DrawingPoint = {
                            time: event.time ?? (0 as TimeMs),
                            price: rs.yToValue(event.y),
                        };
                        // default to pin if 'marker' generic
                        const type = state.activeTool === 'marker' ? 'pin' : state.activeTool as MarkerType;

                        let label = undefined;
                        let color = '#2b5278';
                        let size = 20;

                        if (type === 'swing_high') {
                            label = 'HH';
                            color = '#ef5350';
                        } else if (type === 'swing_low') {
                            label = 'LL';
                            color = '#26a69a';
                        } else if (type === 'bos') {
                            label = 'BOS';
                            color = '#7c4dff';
                            size = 0; // Size handled by badge
                        } else if (type === 'choch') {
                            label = 'CHoCH';
                            color = '#ff7043';
                            size = 0; // Size handled by badge
                        } else if (type === 'liquidity') {
                            color = '#42a5f5';
                        } else if (type === 'invalidation') {
                            label = 'INV';
                            color = '#f23645';  // Red for invalidation
                            size = 0; // Size handled by badge
                        }

                        const newMarker: DrawingMarker = {
                            id: generateMarkerId(),
                            type: type,
                            position: point,
                            color: color,
                            size: size,
                            label: label,
                        };
                        state.markers.push(newMarker);

                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }
                        return true;
                    }

                    if (state.activeTool === 'cross_line') {
                        // Cross line: single click creates H+V intersection
                        const newCross: DrawingCross = {
                            id: generateDrawingId('cross'),
                            time: event.time ?? (0 as TimeMs),
                            price: rs.yToValue(event.y),
                            color: '#2962ff',
                            width: 1,
                        };
                        state.crosses.push(newCross);

                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }
                        return true;
                    }

                    // Note tool: single-click icon+text
                    if (state.activeTool === 'note') {
                        const newNote: DrawingNote = {
                            id: generateDrawingId('note'),
                            position: {
                                time: event.time ?? (0 as TimeMs),
                                price: rs.yToValue(event.y),
                            },
                            text: 'Note',
                            icon: '📌',
                            fontSize: 12,
                            color: '#fc7432',
                            backgroundColor: 'rgba(252, 116, 50, 0.1)',
                            minimized: false,
                        };
                        state.notes.push(newNote);
                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }
                        state.mode = 'idle';
                        return true;
                    }

                    // Callout tool: 2-point (text position, target position)
                    if (state.activeTool === 'callout') {
                        state.pendingPoint = {
                            time: event.time ?? (0 as TimeMs),
                            price: rs.yToValue(event.y),
                        };
                        state.mode = 'drawing';
                        return true;
                    }

                    if (state.activeTool === 'text') {
                        // Text tool: single click creation
                        // Use a simple prompt for now - could be upgraded to an overlay input later
                        const content = prompt('Enter text:', 'Text Label');
                        if (content) {
                            const point: DrawingPoint = {
                                time: event.time ?? (0 as TimeMs),
                                price: rs.yToValue(event.y),
                            };
                            const newText: DrawingText = {
                                id: generateTextId(),
                                type: 'text',
                                position: point,
                                content: content,
                                fontSize: 14,
                                fontColor: '#ffffff',
                                backgroundColor: '#2b5278',
                                backgroundOpacity: 0.7,
                                padding: 8,
                            };
                            state.texts.push(newText);

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }
                        }
                        return true;
                    }

                    if (state.activeTool === 'text') {
                        const content = 'Text';
                        if (content) {
                            // ... (existing text creation) ...
                        }
                        return true;
                    }

                    // Brush / Highlighter: Start drag drawing immediately
                    if (state.activeTool === 'brush' || state.activeTool === 'highlighter') {
                        const point: DrawingPoint = {
                            time: event.time ?? (0 as TimeMs),
                            price: rs.yToValue(event.y),
                        };

                        const newPath: DrawingPath = {
                            id: generatePathId(),
                            type: state.activeTool as PathType,
                            points: [point],
                            color: state.activeTool === 'highlighter' ? '#ffeb3b' : '#fc7432',
                            width: state.activeTool === 'highlighter' ? 12 : 2,
                            smooth: true,
                            fillOpacity: state.activeTool === 'highlighter' ? 0.4 : 0,
                        };

                        if (state.activeTool === 'highlighter') {
                            newPath.style = 'solid';
                            newPath.fillColor = '#ffeb3b'; // Trick to use fill for highlight look? No, wide stroke is better.
                        }

                        state.paths.push(newPath);
                        state.selectedPathId = newPath.id; // Track ID to append points during drag
                        state.mode = 'drawing-brush'; // New mode for continuous drawing
                        return true;
                    }

                    // Arc Tool: 3-point creation (similar to 3-point Fib)
                    if (state.activeTool === 'arc') {
                        const point: DrawingPoint = {
                            time: event.time ?? (0 as TimeMs),
                            price: rs.yToValue(event.y),
                        };
                        state.pendingPoint = point;
                        state.mode = 'drawing';
                        return true;
                    }

                    // Path / Curve / Polyline: Multi-point creation
                    if (state.activeTool === 'path' || state.activeTool === 'polyline' || state.activeTool === 'polygon' || state.activeTool === 'curve' || state.activeTool === 'double_curve') {
                        const point: DrawingPoint = {
                            time: event.time ?? (0 as TimeMs),
                            price: rs.yToValue(event.y),
                        };
                        // Use pendingPatternPoints for temporary storage of path points too
                        state.pendingPatternPoints = [point];
                        state.mode = 'drawing-path'; // Distinct mode from 'drawing' (2-point)
                        return true;
                    }

                    // First click: set p1 for standard 2-point tools
                    state.pendingPoint = {
                        time: event.time ?? (0 as TimeMs),
                        price: rs.yToValue(event.y),
                    };
                    state.mode = 'drawing';
                    return true;

                } else if (state.mode === 'drawing-path') {
                    // Multi-point path creation (Subsequent clicks)
                    // Check for double click or close proximity to end?
                    // For now, just add point. User needs a way to finish (e.g. double click or tool switch).
                    // Implemented: Click adds point.

                    const point: DrawingPoint = {
                        time: event.time ?? (0 as TimeMs),
                        price: rs.yToValue(event.y),
                    };
                    state.pendingPatternPoints.push(point);

                    // Visual feedback is handled by rendering pending pattern points? 
                    // We might need a specific 'renderPendingPath' if we want it to look like the tool.

                    // Check for closing/finishing (e.g. near start point)
                    const startPoint = state.pendingPatternPoints[0];
                    const dist = Math.sqrt(Math.pow(rs.timeToX(point.time) - rs.timeToX(startPoint.time), 2) + Math.pow(rs.valueToY(point.price) - rs.valueToY(startPoint.price), 2));

                    if (state.pendingPatternPoints.length > 2 && dist < 10) {
                        // Close and finish
                        const newPath: DrawingPath = {
                            id: generatePathId(),
                            type: state.activeTool as PathType,
                            points: [...state.pendingPatternPoints], // including closure
                            color: '#fc7432',
                            width: 2,
                            smooth: state.activeTool === 'curve' || state.activeTool === 'double_curve',
                            closed: true,
                            fillColor: 'rgba(252, 116, 50, 0.2)',
                        };
                        state.paths.push(newPath);
                        state.pendingPatternPoints = [];
                        state.mode = 'idle';
                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }
                    }
                    return true;



                    // ... Back to 'drawing' mode (2nd point for 2-point tools)
                } else if (state.mode === 'drawing') {
                    // ... (existing p2 logic) ...
                    const p2: DrawingPoint = {
                        time: rs.xToTime(constrainedMouseX) ?? (0 as TimeMs),
                        price: rs.yToValue(constrainedMouseY),
                    };

                    if (state.activeTool === 'arc') {
                        // Create Arc with p1, p2, wait for p3
                        const newArc: DrawingArc = {
                            id: generateArcId(),
                            p1: state.pendingPoint,
                            p2: p2,
                            p3: null as any, // Temporary
                            color: '#fc7432',
                            width: 2,
                        };
                        state.arcs.push(newArc);
                        state.selectedArcId = newArc.id; // Track for p3 update
                        state.mode = 'drawing-arc-p3';
                        state.pendingPoint = null;
                        return true;
                    }


                    if (state.pendingPoint) {
                        const is3PointTool = ['fib-extension', 'fib-channel', 'parallel-channel', 'pitchfork', 'triangle', 'head_shoulders'].includes(state.activeTool);
                        const is4PointTool = state.activeTool === 'disjoint-channel';

                        if (is4PointTool) {
                            // 4-point tools: create Fib with p1 and p2, then wait for p3 and p4
                            const newFib: DrawingFib = {
                                id: generateFibId(),
                                type: 'disjoint-channel',
                                p1: state.pendingPoint,
                                p2: p2,
                                levels: [...DEFAULT_FLAT_CHANNEL_LEVELS],
                                showBackground: false,
                                backgroundColor: '#787b86',
                            };
                            state.fibs.push(newFib);
                            state.pendingFibId = newFib.id;
                            state.mode = 'drawing-p3'; // Next: wait for 3rd point
                            state.pendingPoint = null;
                            return true;
                        } else if (is3PointTool) {
                            // 3-point tools: create Fib with p1 and p2, then wait for p3
                            const levels = state.activeTool === 'fib-extension'
                                ? DEFAULT_FIB_EXTENSION_LEVELS
                                : state.activeTool === 'parallel-channel'
                                    ? DEFAULT_PARALLEL_CHANNEL_LEVELS
                                    : state.activeTool === 'pitchfork'
                                        ? DEFAULT_PITCHFORK_LEVELS
                                        : DEFAULT_FIB_CHANNEL_LEVELS;

                            const newFib: DrawingFib = {
                                id: generateFibId(),
                                type: state.activeTool as FibType,
                                p1: state.pendingPoint,
                                p2: p2,
                                // p3 not set yet
                                levels: [...levels],
                                showBackground: false,
                                backgroundColor: '#fc7432',
                            };
                            state.fibs.push(newFib);
                            state.pendingFibId = newFib.id;
                            state.mode = 'drawing-p3';
                            state.pendingPoint = null;
                            state.pendingFibId = newFib.id;
                            state.mode = 'drawing-p3';
                            state.pendingPoint = null;
                            return true;
                        } else if (state.activeTool === 'std-dev-channel' || state.activeTool === 'regression-trend') {
                            // 2-point Statistical Channels: calculate regression and finalize immediately
                            if (!state.dataAccessor) {
                                console.warn('Data accessor not set - statistical channels will not work');
                                state.mode = 'idle';
                                state.pendingPoint = null;
                                return true;
                            }

                            // Fetch OHLC data between p1 and p2
                            const startTime = Math.min(state.pendingPoint.time, p2.time);
                            const endTime = Math.max(state.pendingPoint.time, p2.time);
                            const data = state.dataAccessor(startTime, endTime);

                            if (data.length < 2) {
                                console.warn('Not enough data points for statistical channel');
                                state.mode = 'idle';
                                state.pendingPoint = null;
                                return true;
                            }

                            // Calculate linear regression
                            const regression = calculateLinearRegression(data, startTime);
                            const stdDev = calculateStandardDeviation(regression.points, regression);

                            // Choose levels based on tool type
                            const levels = state.activeTool === 'std-dev-channel'
                                ? DEFAULT_STD_DEV_CHANNEL_LEVELS
                                : DEFAULT_REGRESSION_TREND_LEVELS;

                            const newFib: DrawingFib = {
                                id: generateFibId(),
                                type: state.activeTool,
                                p1: state.pendingPoint,
                                p2: p2,
                                levels: [...levels],
                                showBackground: false,
                                backgroundColor: '#2962ff',
                                regressionData: {
                                    slope: regression.slope,
                                    intercept: regression.intercept,
                                    stdDev: stdDev,
                                    dataPointCount: data.length,
                                    startTime: startTime,
                                    endTime: endTime,
                                },
                            };
                            state.fibs.push(newFib);

                            if (fibCompleteCallback) {
                                fibCompleteCallback(newFib);
                            }

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;
                        } else if (state.activeTool === 'flat-top-bottom') {
                            // 2-point Flat Top/Bottom Channel: one horizontal, one sloped
                            // Determine mode based on price relationship
                            const isFlatTop = p2.price < state.pendingPoint.price; // Descending = flat top

                            const newFib: DrawingFib = {
                                id: generateFibId(),
                                type: 'flat-top-bottom',
                                p1: state.pendingPoint,  // Reference point (horizontal line)
                                p2: p2,                   // Second point (determines slope)
                                levels: [...DEFAULT_FLAT_CHANNEL_LEVELS],
                                showBackground: false,
                                backgroundColor: '#787b86',
                            };
                            state.fibs.push(newFib);

                            if (fibCompleteCallback) {
                                fibCompleteCallback(newFib);
                            }

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;
                        } else if (state.activeTool === 'fib-retracement') {
                            // 2-point Fib Retracement: finalize immediately
                            const newFib: DrawingFib = {
                                id: generateFibId(),
                                type: 'fib-retracement',
                                p1: state.pendingPoint,
                                p2: p2,
                                levels: [...DEFAULT_FIB_LEVELS],
                                showBackground: true,
                                backgroundColor: '#fc7432',
                            };
                            state.fibs.push(newFib);

                            if (fibCompleteCallback) {
                                fibCompleteCallback(newFib);
                            }

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;

                        } else if (state.activeTool === 'rectangle' || Object.keys(ZONE_COLORS).includes(state.activeTool)) {
                            // Rectangle tool or Smart Zone

                            let fillColor = '#4a90d9';
                            let strokeColor = '#2b5278';
                            let zoneType: ZoneType | undefined = undefined;
                            let label: string | undefined = undefined;
                            let labelPosition: any = undefined;

                            if (Object.keys(ZONE_COLORS).includes(state.activeTool)) {
                                zoneType = state.activeTool as ZoneType;
                                const colors = ZONE_COLORS[zoneType];
                                fillColor = colors.fill;
                                strokeColor = colors.stroke;

                                // Set default labels
                                if (zoneType === 'supply') label = 'Supply';
                                else if (zoneType === 'demand') label = 'Demand';
                                else if (zoneType === 'order_block') label = 'OB';
                                else if (zoneType === 'fvg') label = 'FVG';
                                else if (zoneType === 'breaker') label = 'Breaker';
                                else if (zoneType === 'session') label = 'Session';
                                else if (zoneType === 'or') label = 'Opening Range';

                                labelPosition = 'top-right';
                            }

                            const newRect: DrawingRect = {
                                id: generateRectId(),
                                p1: state.pendingPoint,
                                p2: p2,
                                fillColor: fillColor,
                                strokeColor: strokeColor,
                                strokeWidth: 2,
                                fillOpacity: 0.25,
                                zoneType: zoneType,
                                label: label,
                                labelPosition: labelPosition
                            };
                            state.rects.push(newRect);

                            if (rectCompleteCallback) {
                                rectCompleteCallback(newRect);
                            }

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;

                        } else if (state.activeTool === 'ellipse' || state.activeTool === 'circle') {
                            // Ellipse/Circle tool: create shape from p1 to p2
                            const newEllipse: DrawingEllipse = {
                                id: generateEllipseId(),
                                type: state.activeTool as EllipseType,
                                p1: state.pendingPoint,
                                p2: p2,
                                fillColor: '#e6a030',
                                strokeColor: '#b87a20',
                                strokeWidth: 2,
                                fillOpacity: 0.25,
                            };
                            state.ellipses.push(newEllipse);

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;

                        } else if (state.activeTool === 'price_range' || state.activeTool === 'date_range' || state.activeTool === 'combined_range') {
                            const newMeasure: DrawingMeasure = {
                                id: generateMeasureId(),
                                type: state.activeTool === 'combined_range' ? 'combined_range' : state.activeTool as MeasureType,
                                p1: state.pendingPoint,
                                p2: p2,
                                color: '#2b5278',
                                backgroundColor: '#2b5278',
                                backgroundOpacity: 0.2,
                                strokeWidth: 2,
                            };
                            state.measures.push(newMeasure);

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;

                        } else if (state.activeTool === 'fixed_range_volume_profile') {
                            const newMeasure: DrawingMeasure = {
                                id: generateMeasureId(),
                                type: 'fixed_range_volume_profile',
                                p1: state.pendingPoint,
                                p2: p2,
                                color: '#2b5278',
                                backgroundColor: '#2b5278',
                                backgroundOpacity: 0.1,
                                strokeWidth: 2,
                            };
                            state.measures.push(newMeasure);
                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }
                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;

                        } else if (state.activeTool === 'gann_fan' || state.activeTool === 'gann_box') {
                            const newGann: DrawingGann = {
                                id: generateGannId(),
                                type: state.activeTool,
                                p1: state.pendingPoint,
                                p2: p2,
                                color: '#2962ff',
                                width: 1,
                                showLabels: true,
                                angles: [...DEFAULT_GANN_ANGLES],
                            };
                            state.ganns.push(newGann);

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;

                        } else if (state.activeTool === 'xabcd' || state.activeTool === 'abcd' ||
                            state.activeTool === 'triangle' || state.activeTool === 'head_shoulders') {
                            // Multi-point pattern creation
                            const toolType = state.activeTool as PatternType;
                            const requiredPoints = PATTERN_POINT_COUNTS[toolType];
                            const labels = PATTERN_LABELS[toolType] || [];

                            // Add this point to pending points
                            state.pendingPatternPoints.push(p2);

                            // Check if we have all required points
                            if (state.pendingPatternPoints.length >= requiredPoints) {
                                // Create the pattern
                                const newPattern: DrawingPattern = {
                                    id: generatePatternId(),
                                    type: toolType,
                                    points: [...state.pendingPatternPoints],
                                    labels: labels,
                                    color: '#fc7432',
                                    width: 2,
                                    showLabels: true,
                                    showRatios: toolType === 'xabcd' || toolType === 'abcd',
                                    fillColor: 'rgba(252, 116, 50, 0.1)',
                                    fillOpacity: 0.1,
                                };
                                state.patterns.push(newPattern);

                                // Clear pending state
                                state.pendingPatternPoints = [];
                                state.pendingPoint = null;
                                state.mode = 'idle';

                                if (autoSwitchToSelect) {
                                    state.activeTool = 'select';
                                    resetCursor();
                                }
                            } else {
                                // Keep drawing mode active, use last point as new pending
                                state.pendingPoint = p2;
                            }

                            chartRef?.requestRender?.();
                            return true;

                        } else if (state.activeTool === 'long_position' || state.activeTool === 'short_position' || state.activeTool === 'multi_target' || state.activeTool === 'scaled_entry') {
                            // Position creation with auto-calculated target/stop (2:1 R:R)
                            const isLong = state.activeTool === 'long_position' || state.activeTool === 'multi_target' || state.activeTool === 'scaled_entry'; // Default to long for new types
                            const entryPrice = state.pendingPoint.price;
                            const mousePrice = p2.price;

                            // Calculate target/stop based on R:R and drag distance
                            const priceMove = Math.abs(mousePrice - entryPrice);
                            const risk = priceMove > 0 ? priceMove : entryPrice * 0.02; // Default 2% if no significant drag
                            const targetPrice = isLong ? entryPrice + risk * 2 : entryPrice - risk * 2;
                            const stopPrice = isLong ? entryPrice - risk : entryPrice + risk;

                            const newPosition: DrawingPosition = {
                                id: generatePositionId(),
                                type: isLong ? 'long' : 'short',
                                entryPrice: entryPrice,
                                targetPrice: targetPrice,
                                stopPrice: stopPrice,
                                startTime: rs.xToTime(rs.timeToX(state.pendingPoint.time)),
                                endTime: rs.xToTime(currentMouseX),
                                profitColor: 'rgba(76, 175, 80, 0.25)',
                                lossColor: 'rgba(255, 82, 82, 0.25)',
                                entryColor: '#787b86',
                                opacity: 0.25,
                                showLabels: true,
                                showRatio: true,
                            };

                            // Add default targets/entries for new tools
                            if (state.activeTool === 'multi_target') {
                                newPosition.targets = [
                                    { price: entryPrice + (targetPrice - entryPrice) * 0.5, label: 'TP1', percentage: 25 },
                                    { price: targetPrice, label: 'TP2', percentage: 25 },
                                    { price: targetPrice + (targetPrice - entryPrice) * 0.5, label: 'TP3', percentage: 25 },
                                    { price: targetPrice + (targetPrice - entryPrice) * 1.0, label: 'TP4', percentage: 25 },
                                ];
                            } else if (state.activeTool === 'scaled_entry') {
                                const range = entryPrice - stopPrice;
                                newPosition.scaledEntries = [
                                    { price: entryPrice + range * 0.3, percentage: 30 },
                                    { price: entryPrice, percentage: 40 },
                                    { price: entryPrice - range * 0.3, percentage: 30 },
                                ];
                            }

                            state.positions.push(newPosition);

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;
                        } else if (state.activeTool === 'forecast' || state.activeTool === 'projection' || state.activeTool === 'bars_pattern' || state.activeTool === 'ghost_feed') {
                            const newForecast: DrawingForecast = {
                                id: generateForecastId(),
                                type: state.activeTool as ForecastType,
                                startPoint: state.pendingPoint,
                                endPoint: p2,
                                color: '#fc7432',
                                width: 2,
                                style: state.activeTool === 'projection' ? 'dashed' : 'solid',
                            };
                            state.forecasts.push(newForecast);

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;
                        } else {
                            // Regular line tools (and Anchored VWAP)
                            const newLine: DrawingLine = {
                                id: generateLineId(),
                                type: state.activeTool === 'anchored_vwap' ? 'anchored_vwap' : state.activeTool as LineType,
                                p1: state.pendingPoint,
                                p2: p2,
                                color: state.activeTool === 'horizontal' || state.activeTool === 'cross_line' || state.activeTool === 'anchored_vwap' ? '#2962ff' : '#fc7432',
                                width: 2,
                            };

                            if (state.activeTool === 'anchored_vwap') {
                                newLine.color = '#ff9800'; // Specific color for AVWAP
                                newLine.dash = [4, 2];
                            }

                            // Price label: horizontal line with price badge
                            if (state.activeTool === 'price_label') {
                                newLine.type = 'horizontal';
                                newLine.showLabel = true;
                                newLine.labelText = undefined; // Will default to price.toFixed(2)
                            }

                            // Callout: complete 2-point creation
                            if (state.activeTool === 'callout') {
                                const newCallout: DrawingCallout = {
                                    id: generateDrawingId('callout'),
                                    textPosition: state.pendingPoint,
                                    targetPosition: p2,
                                    text: 'Callout',
                                    fontSize: 12,
                                    fontColor: '#fc7432',
                                    backgroundColor: 'rgba(252, 116, 50, 0.15)',
                                    arrowColor: '#fc7432',
                                };
                                state.callouts.push(newCallout);

                                state.pendingPoint = null;
                                state.mode = 'idle';

                                if (autoSwitchToSelect) {
                                    state.activeTool = 'select';
                                    resetCursor();
                                }
                                return true;
                            }

                            state.lines.push(newLine);

                            if (lineCompleteCallback) {
                                lineCompleteCallback(newLine);
                            }

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingPoint = null;
                            return true;
                        }
                    }

                } else if (event.type === 'move' || event.type === 'drag') {
                    if (state.mode === 'drawing-brush') {
                        // Continuous drawing: add points to selected path
                        const path = state.paths.find(p => p.id === state.selectedPathId);
                        if (path) {
                            const point: DrawingPoint = {
                                time: event.time ?? (0 as TimeMs),
                                price: rs.yToValue(event.y),
                            };
                            path.points.push(point);
                            chartRef?.requestRender?.();
                            return true;
                        }
                    } else if (state.mode === 'drawing-arc-p3') {
                        // Update p3 of selected arc
                        const arc = state.arcs.find(a => a.id === state.selectedArcId);
                        if (arc) {
                            const p3: DrawingPoint = {
                                time: rs.xToTime(constrainedMouseX) ?? (0 as TimeMs),
                                price: rs.yToValue(constrainedMouseY),
                            };
                            arc.p3 = p3;
                            chartRef?.requestRender?.();
                            return true;
                        }
                    }

                } else if (event.type === 'up') {
                    if (state.mode === 'drawing-brush') {
                        // Finish brush drawing
                        state.mode = 'idle';
                        state.selectedPathId = null;
                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }
                        return true;
                    } else if (state.mode === 'drawing-arc-p3') {
                        // Finish arc drawing (User clicked to set p3)
                        // Wait, 'up' event might be from the click that set p2? 
                        // Logic: 
                        // Click 1 (down+up): p1
                        // Click 2 (down+up): p2 -> set mode drawing-arc-p3
                        // Click 3 (down): set p3 -> finish? 

                        // If we are in 'drawing-arc-p3' mode, a 'down' event should finish it.
                        // We need to handle 'down' for drawing-arc-p3.
                    }
                }

                if (state.mode === 'drawing-arc-p3' && event.type === 'down') {
                    // Finalize Arc
                    const arc = state.arcs.find(a => a.id === state.selectedArcId);
                    if (arc) {
                        const p3: DrawingPoint = {
                            time: rs.xToTime(constrainedMouseX) ?? (0 as TimeMs),
                            price: rs.yToValue(constrainedMouseY),
                        };
                        arc.p3 = p3;
                        state.mode = 'idle';
                        state.selectedArcId = null;
                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }
                        return true;
                    }
                }

                if (state.mode === 'drawing-p3') {
                    // Third click: set p3 for Extension/Channel OR continue to p4 for disjoint-channel
                    const p3: DrawingPoint = {
                        time: event.time ?? (0 as TimeMs),
                        price: rs.yToValue(event.y),
                    };

                    const pendingFib = state.fibs.find(f => f.id === state.pendingFibId);
                    if (pendingFib) {
                        pendingFib.p3 = p3;

                        // Check if this is a 4-point tool that needs p4
                        if (pendingFib.type === 'disjoint-channel') {
                            // Continue to p4 for disjoint channel
                            state.mode = 'drawing-p4';
                            return true;
                        } else {
                            // 3-point tools are complete
                            if (fibCompleteCallback) {
                                fibCompleteCallback(pendingFib);
                            }

                            if (autoSwitchToSelect) {
                                state.activeTool = 'select';
                                resetCursor();
                            }

                            state.mode = 'idle';
                            state.pendingFibId = null;
                            return true;
                        }
                    }
                }

                if (state.mode === 'drawing-p4') {
                    // Fourth click: set p4 for disjoint-channel
                    const p4: DrawingPoint = {
                        time: event.time ?? (0 as TimeMs),
                        price: rs.yToValue(event.y),
                    };

                    const pendingFib = state.fibs.find(f => f.id === state.pendingFibId);
                    if (pendingFib) {
                        pendingFib.p4 = p4;

                        if (fibCompleteCallback) {
                            fibCompleteCallback(pendingFib);
                        }

                        if (autoSwitchToSelect) {
                            state.activeTool = 'select';
                            resetCursor();
                        }

                        state.mode = 'idle';
                        state.pendingFibId = null;
                        return true;
                    }
                }
            }
        },
    };

    return { ...plugin, api };
};

export default createDrawingPlugin;
