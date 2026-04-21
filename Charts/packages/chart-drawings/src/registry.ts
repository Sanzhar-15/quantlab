/**
 * Drawing type registry with 15 MVP drawing types.
 */

import type {
  Drawing,
  DrawingType,
  DrawingCategory,
  DrawingStyle,
  Point,
  HitTestResult,
  Handle,
} from './types';

/**
 * Drawing type definition.
 */
export interface DrawingTypeDefinition {
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
  
  // Factory function
  create: (anchors: AnchorPoint[], style?: Partial<DrawingStyle>) => Drawing;
  
  // Hit testing
  hitTest: (drawing: Drawing, point: Point, tolerance: number) => HitTestResult | null;
  
  // Get handles for editing
  getHandles: (drawing: Drawing) => Handle[];
}

/**
 * Drawing registry.
 */
export class DrawingRegistry {
  private definitions = new Map<DrawingType, DrawingTypeDefinition>();

  /**
   * Register a drawing type.
   */
  public register(definition: DrawingTypeDefinition): void {
    if (this.definitions.has(definition.type)) {
      throw new Error(`Drawing type ${definition.type} is already registered`);
    }
    this.definitions.set(definition.type, definition);
  }

  /**
   * Get drawing type definition.
   */
  public get(type: DrawingType): DrawingTypeDefinition | undefined {
    return this.definitions.get(type);
  }

  /**
   * Get all registered drawing types.
   */
  public getAll(): DrawingTypeDefinition[] {
    return Array.from(this.definitions.values());
  }

  /**
   * Get drawing types by category.
   */
  public getByCategory(category: DrawingCategory): DrawingTypeDefinition[] {
    return Array.from(this.definitions.values()).filter((def) => def.category === category);
  }

  /**
   * Check if drawing type is registered.
   */
  public has(type: DrawingType): boolean {
    return this.definitions.has(type);
  }
}

/**
 * Create default drawing registry with 15 MVP drawing types.
 */
export function createDefaultRegistry(): DrawingRegistry {
  const registry = new DrawingRegistry();

  // Helper function to generate UUID
  const generateId = () => {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  };

  // Helper function to create base drawing
  const createBaseDrawing = (
    type: DrawingType,
    anchors: AnchorPoint[],
    style?: Partial<DrawingStyle>,
  ): Drawing => {
    const defaultStyle: DrawingStyle = {
      strokeColor: '#2962ff',
      strokeWidth: 1,
      strokeStyle: 'solid',
      ...style,
    };

    return {
      id: generateId(),
      type,
      paneId: '',
      anchors,
      style: defaultStyle,
      visible: true,
      locked: false,
      createdAt: Date.now(),
      modifiedAt: Date.now(),
      revision: 1,
    };
  };

  // Trend Line
  registry.register({
    type: 'trend_line',
    name: 'Trend Line',
    icon: 'trend-line',
    category: 'lines',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'End'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    allowExtend: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('trend_line', anchors, style) as TrendLineDrawing;
      drawing.extendLeft = false;
      drawing.extendRight = false;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => {
      // TODO: Implement line hit testing
      return null;
    },
    getHandles: (drawing) => {
      // TODO: Return handles for anchor points
      return [];
    },
  });

  // Horizontal Line
  registry.register({
    type: 'horizontal_line',
    name: 'Horizontal Line',
    icon: 'horizontal-line',
    category: 'lines',
    minAnchors: 1,
    maxAnchors: 1,
    anchorLabels: ['Price'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    create: (anchors, style) => createBaseDrawing('horizontal_line', anchors, style),
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Vertical Line
  registry.register({
    type: 'vertical_line',
    name: 'Vertical Line',
    icon: 'vertical-line',
    category: 'lines',
    minAnchors: 1,
    maxAnchors: 1,
    anchorLabels: ['Time'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    create: (anchors, style) => createBaseDrawing('vertical_line', anchors, style),
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Ray
  registry.register({
    type: 'ray',
    name: 'Ray',
    icon: 'ray',
    category: 'lines',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'Direction'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    allowExtend: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('ray', anchors, style) as RayDrawing;
      drawing.extendRight = true;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Extended Line
  registry.register({
    type: 'extended_line',
    name: 'Extended Line',
    icon: 'extended-line',
    category: 'lines',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'End'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    allowExtend: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('extended_line', anchors, style) as ExtendedLineDrawing;
      drawing.extendLeft = true;
      drawing.extendRight = true;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Parallel Channel
  registry.register({
    type: 'parallel_channel',
    name: 'Parallel Channel',
    icon: 'parallel-channel',
    category: 'channels',
    minAnchors: 3,
    maxAnchors: 3,
    anchorLabels: ['Start', 'End', 'Width'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1, fillColor: 'rgba(41, 98, 255, 0.1)' },
    allowFill: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('parallel_channel', anchors, style) as ParallelChannelDrawing;
      drawing.fillColor = style?.fillColor || 'rgba(41, 98, 255, 0.1)';
      drawing.fillOpacity = style?.fillOpacity || 0.1;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Fibonacci Retracement
  registry.register({
    type: 'fib_retracement',
    name: 'Fibonacci Retracement',
    icon: 'fib-retracement',
    category: 'fibonacci',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'End'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    hasComputedLevels: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('fib_retracement', anchors, style) as FibRetracementDrawing;
      drawing.levels = [
        { ratio: 0, color: '#2962ff', visible: true, lineStyle: 'solid' },
        { ratio: 0.236, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 0.382, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 0.5, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 0.618, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 0.786, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 1, color: '#2962ff', visible: true, lineStyle: 'solid' },
      ];
      drawing.showPrices = true;
      drawing.showPercentages = true;
      drawing.reverseDirection = false;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Fibonacci Extension
  registry.register({
    type: 'fib_extension',
    name: 'Fibonacci Extension',
    icon: 'fib-extension',
    category: 'fibonacci',
    minAnchors: 3,
    maxAnchors: 3,
    anchorLabels: ['Start', 'Retrace', 'Extension'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    hasComputedLevels: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('fib_extension', anchors, style) as FibExtensionDrawing;
      drawing.levels = [
        { ratio: 0, color: '#2962ff', visible: true, lineStyle: 'solid' },
        { ratio: 0.618, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 1, color: '#2962ff', visible: true, lineStyle: 'solid' },
        { ratio: 1.618, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
        { ratio: 2.618, color: '#ff6d00', visible: true, lineStyle: 'dashed' },
      ];
      drawing.showPrices = true;
      drawing.showPercentages = true;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Rectangle
  registry.register({
    type: 'rectangle',
    name: 'Rectangle',
    icon: 'rectangle',
    category: 'shapes',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Top Left', 'Bottom Right'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1, fillColor: 'rgba(41, 98, 255, 0.1)' },
    allowFill: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('rectangle', anchors, style) as RectangleDrawing;
      drawing.fillColor = style?.fillColor || 'rgba(41, 98, 255, 0.1)';
      drawing.fillOpacity = style?.fillOpacity || 0.1;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Ellipse
  registry.register({
    type: 'ellipse',
    name: 'Ellipse',
    icon: 'ellipse',
    category: 'shapes',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Center', 'Radius'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1, fillColor: 'rgba(41, 98, 255, 0.1)' },
    allowFill: true,
    create: (anchors, style) => {
      const drawing = createBaseDrawing('ellipse', anchors, style) as EllipseDrawing;
      drawing.fillColor = style?.fillColor || 'rgba(41, 98, 255, 0.1)';
      drawing.fillOpacity = style?.fillOpacity || 0.1;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Text
  registry.register({
    type: 'text',
    name: 'Text',
    icon: 'text',
    category: 'annotations',
    minAnchors: 1,
    maxAnchors: 1,
    anchorLabels: ['Position'],
    defaultStyle: { textColor: '#ffffff', fontSize: 12, fontFamily: 'Arial' },
    create: (anchors, style) => {
      const drawing = createBaseDrawing('text', anchors, style) as TextDrawing;
      drawing.content = '';
      drawing.backgroundColor = style?.backgroundColor;
      drawing.borderColor = style?.borderColor;
      drawing.padding = 4;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Arrow
  registry.register({
    type: 'arrow',
    name: 'Arrow',
    icon: 'arrow',
    category: 'annotations',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'End'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 2 },
    create: (anchors, style) => {
      const drawing = createBaseDrawing('arrow', anchors, style) as ArrowDrawing;
      drawing.arrowStyle = 'filled';
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Price Range
  registry.register({
    type: 'price_range',
    name: 'Price Range',
    icon: 'price-range',
    category: 'measurements',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'End'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    create: (anchors, style) => {
      const drawing = createBaseDrawing('price_range', anchors, style) as PriceRangeDrawing;
      drawing.showPercentage = true;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Date Range
  registry.register({
    type: 'date_range',
    name: 'Date Range',
    icon: 'date-range',
    category: 'measurements',
    minAnchors: 2,
    maxAnchors: 2,
    anchorLabels: ['Start', 'End'],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 1 },
    create: (anchors, style) => {
      const drawing = createBaseDrawing('date_range', anchors, style) as DateRangeDrawing;
      drawing.showBarsCount = true;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  // Brush
  registry.register({
    type: 'brush',
    name: 'Brush',
    icon: 'brush',
    category: 'brushes',
    minAnchors: 0,
    maxAnchors: 0,
    anchorLabels: [],
    defaultStyle: { strokeColor: '#2962ff', strokeWidth: 2 },
    create: (anchors, style) => {
      const drawing = createBaseDrawing('brush', anchors, style) as BrushDrawing;
      drawing.pathData = new ArrayBuffer(0);
      drawing.smoothing = 0.5;
      return drawing;
    },
    hitTest: (drawing, point, tolerance) => null,
    getHandles: (drawing) => [],
  });

  return registry;
}

// Import AnchorPoint type
import type { AnchorPoint } from './types';
import type {
  TrendLineDrawing,
  RayDrawing,
  ExtendedLineDrawing,
  ParallelChannelDrawing,
  FibRetracementDrawing,
  FibExtensionDrawing,
  RectangleDrawing,
  EllipseDrawing,
  TextDrawing,
  ArrowDrawing,
  PriceRangeDrawing,
  DateRangeDrawing,
  BrushDrawing,
} from './types';

