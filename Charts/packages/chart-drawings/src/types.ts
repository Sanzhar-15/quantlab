/**
 * Drawing tools type definitions.
 */

/**
 * Drawing type identifier.
 */
export type DrawingType =
  | 'trend_line'
  | 'horizontal_line'
  | 'vertical_line'
  | 'ray'
  | 'extended_line'
  | 'parallel_channel'
  | 'fib_retracement'
  | 'fib_extension'
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'arrow'
  | 'price_range'
  | 'date_range'
  | 'brush';

/**
 * Drawing category.
 */
export type DrawingCategory = 'lines' | 'channels' | 'fibonacci' | 'shapes' | 'annotations' | 'measurements' | 'brushes';

/**
 * Anchor point in data coordinates.
 */
export interface AnchorPoint {
  time: number;                  // Unix timestamp ms
  price: number;                  // Price value
  barIndex?: number;              // Optional: for snapped anchors
}

/**
 * Drawing style.
 */
export interface DrawingStyle {
  // Stroke
  strokeColor: string;           // Hex color
  strokeWidth: number;           // CSS pixels
  strokeStyle: 'solid' | 'dashed' | 'dotted';

  // Fill (for shapes)
  fillColor?: string;
  fillOpacity?: number;          // 0-1

  // Text (for annotations)
  fontSize?: number;
  fontFamily?: string;
  textColor?: string;

  // NEW-CH-007: Rendering control properties
  /** Whether drawing is visible */
  visible?: boolean;
  /** Whether drawing is locked (can't be moved/edited) */
  locked?: boolean;
  /** Z-index for rendering order within the drawing layer */
  zIndex?: number;
}

// NEW-CH-007: Default style applied when no style is specified
export const DEFAULT_DRAWING_STYLE: DrawingStyle = {
  strokeColor: '#2196F3',
  strokeWidth: 1,
  strokeStyle: 'solid',
  fillColor: '',
  fillOpacity: 0.2,
  textColor: '#ffffff',
  fontSize: 12,
  fontFamily: 'monospace',
  visible: true,
  locked: false,
  zIndex: 0,
};

/**
 * Base drawing interface.
 */
export interface Drawing {
  // Identity
  id: string;                    // UUID
  type: DrawingType;
  
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

/**
 * Type-specific drawing extensions.
 */
export interface TrendLineDrawing extends Drawing {
  type: 'trend_line';
  extendLeft: boolean;
  extendRight: boolean;
}

export interface HorizontalLineDrawing extends Drawing {
  type: 'horizontal_line';
  // Single anchor point (price level)
}

export interface VerticalLineDrawing extends Drawing {
  type: 'vertical_line';
  // Single anchor point (timestamp)
}

export interface RayDrawing extends Drawing {
  type: 'ray';
  extendRight: boolean;
}

export interface ExtendedLineDrawing extends Drawing {
  type: 'extended_line';
  extendLeft: boolean;
  extendRight: boolean;
}

export interface ParallelChannelDrawing extends Drawing {
  type: 'parallel_channel';
  fillColor?: string;
  fillOpacity?: number;
}

export interface FibRetracementDrawing extends Drawing {
  type: 'fib_retracement';
  levels: FibLevel[];
  showPrices: boolean;
  showPercentages: boolean;
  reverseDirection: boolean;
}

export interface FibExtensionDrawing extends Drawing {
  type: 'fib_extension';
  levels: FibLevel[];
  showPrices: boolean;
  showPercentages: boolean;
}

export interface RectangleDrawing extends Drawing {
  type: 'rectangle';
  fillColor?: string;
  fillOpacity?: number;
}

export interface EllipseDrawing extends Drawing {
  type: 'ellipse';
  fillColor?: string;
  fillOpacity?: number;
}

export interface TextDrawing extends Drawing {
  type: 'text';
  content: string;
  backgroundColor?: string;
  borderColor?: string;
  padding: number;
}

export interface ArrowDrawing extends Drawing {
  type: 'arrow';
  arrowStyle: 'simple' | 'filled';
}

export interface PriceRangeDrawing extends Drawing {
  type: 'price_range';
  showPercentage: boolean;
}

export interface DateRangeDrawing extends Drawing {
  type: 'date_range';
  showBarsCount: boolean;
}

export interface BrushDrawing extends Drawing {
  type: 'brush';
  pathData: ArrayBuffer;         // Compressed path
  smoothing: number;             // 0-1
}

/**
 * Fibonacci level.
 */
export interface FibLevel {
  ratio: number;                 // 0, 0.236, 0.382, 0.5, 0.618, 0.786, 1.0
  color: string;
  visible: boolean;
  lineStyle: 'solid' | 'dashed';
}

/**
 * Hit test result.
 */
export interface HitTestResult {
  type: 'handle' | 'body' | 'edge' | 'segment';
  handleIndex?: number;
  edgeIndex?: number;
  distance: number;
  t?: number;                    // Parameter along segment (0-1)
}

/**
 * Drawing handle (for editing).
 */
export interface Handle {
  anchorIndex: number;
  position: { x: number; y: number }; // Screen coordinates
  visible: boolean;
}

/**
 * Point in screen coordinates.
 */
export interface Point {
  x: number;
  y: number;
}

/**
 * Rectangle in screen coordinates.
 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

