// Tool Definitions
// Based on LHS_BAR_TOOLS.md specification

import type { Tool, ToolCategory } from './types';

// Default tools per category (activated on first click)
export const DEFAULT_TOOLS: Record<ToolCategory, string> = {
    levels: 'h_line',
    trend: 'trend_line',
    structure: 'parallel_channel',
    zones: 'rectangle',
    overlays: 'fib_retracement',
    patterns: 'triangle_pattern',
    plan: 'long_position',
    measure: 'quick_measure',
    annotate: 'text',
};

// All tool definitions
export const TOOLS: Tool[] = [
    // ═══ LEVELS ═══
    { id: 'h_line', name: 'Horizontal Line', category: 'levels', icon: '─', shortcut: 'L' },
    { id: 'h_ray', name: 'Horizontal Ray', category: 'levels', icon: '→' },
    { id: 'v_line', name: 'Vertical Line', category: 'levels', icon: '│' },
    { id: 'cross_line', name: 'Cross Line', category: 'levels', icon: '┼' },
    { id: 'price_label', name: 'Price Label', category: 'levels', icon: '●' },

    // ═══ TREND ═══
    { id: 'trend_line', name: 'Trend Line', category: 'trend', icon: '╱', shortcut: 'T' },
    { id: 'ray', name: 'Ray', category: 'trend', icon: '↗' },
    { id: 'extended_line', name: 'Extended Line', category: 'trend', icon: '↔' },
    { id: 'info_line', name: 'Info Line', category: 'trend', icon: '📊' },
    { id: 'trend_angle', name: 'Trend Angle', category: 'trend', icon: '∠' },
    { id: 'arrow_line', name: 'Arrow Line', category: 'trend', icon: '➤' },

    // ═══ STRUCTURE - Channels ═══
    { id: 'parallel_channel', name: 'Parallel Channel', category: 'structure', subcategory: 'channels', icon: '⫽', shortcut: 'S' },
    { id: 'regression_trend', name: 'Regression Trend', category: 'structure', subcategory: 'channels', icon: '📈' },
    { id: 'flat_top_bottom', name: 'Flat Top/Bottom', category: 'structure', subcategory: 'channels', icon: '⌐' },
    { id: 'disjoint_channel', name: 'Disjoint Channel', category: 'structure', subcategory: 'channels', icon: '⫽' },
    { id: 'std_dev_channel', name: 'Std Deviation Channel', category: 'structure', subcategory: 'channels', icon: 'σ', isNew: true },

    // ═══ STRUCTURE - Pitchforks ═══
    { id: 'pitchfork', name: "Andrews' Pitchfork", category: 'structure', subcategory: 'pitchforks', icon: '⋔' },
    { id: 'schiff_pitchfork', name: 'Schiff Pitchfork', category: 'structure', subcategory: 'pitchforks', icon: '⋔' },
    { id: 'modified_schiff', name: 'Modified Schiff', category: 'structure', subcategory: 'pitchforks', icon: '⋔' },
    { id: 'inside_pitchfork', name: 'Inside Pitchfork', category: 'structure', subcategory: 'pitchforks', icon: '⋔' },
    { id: 'pitchfan', name: 'Pitchfan', category: 'structure', subcategory: 'pitchforks', icon: '⋔' },

    // ═══ STRUCTURE - Market Structure (★ New) ═══
    { id: 'swing_label', name: 'Swing High/Low', category: 'structure', subcategory: 'market_structure', icon: '⟰', isNew: true },
    { id: 'bos_marker', name: 'BOS Marker', category: 'structure', subcategory: 'market_structure', icon: '⚡', isNew: true },
    { id: 'choch_marker', name: 'CHoCH Marker', category: 'structure', subcategory: 'market_structure', icon: '↻', isNew: true },
    { id: 'invalidation_zone', name: 'Invalidation Zone', category: 'structure', subcategory: 'market_structure', icon: '▢', isNew: true },
    { id: 'liquidity_sweep', name: 'Liquidity Sweep', category: 'structure', subcategory: 'market_structure', icon: '💧', isNew: true },

    // ═══ ZONES - Basic ═══
    { id: 'rectangle', name: 'Rectangle', category: 'zones', subcategory: 'basic', icon: '▭', shortcut: 'Z' },
    { id: 'rotated_rectangle', name: 'Rotated Rectangle', category: 'zones', subcategory: 'basic', icon: '◇' },

    // ═══ ZONES - Smart (★ New) ═══
    { id: 'supply_demand_zone', name: 'Supply/Demand Zone', category: 'zones', subcategory: 'smart', icon: 'S/D', isNew: true },
    { id: 'order_block', name: 'Order Block', category: 'zones', subcategory: 'smart', icon: 'OB', isNew: true },
    { id: 'fair_value_gap', name: 'Fair Value Gap', category: 'zones', subcategory: 'smart', icon: 'FVG', isNew: true },
    { id: 'breaker_block', name: 'Breaker Block', category: 'zones', subcategory: 'smart', icon: 'BB', isNew: true },

    // ═══ ZONES - Session (★ New) ═══
    { id: 'session_box', name: 'Session Box', category: 'zones', subcategory: 'session', icon: '🌏', isNew: true },
    { id: 'opening_range', name: 'Opening Range', category: 'zones', subcategory: 'session', icon: 'OR', isNew: true },

    // ═══ OVERLAYS - Fibonacci ═══
    { id: 'fib_retracement', name: 'Fib Retracement', category: 'overlays', subcategory: 'fib', icon: 'ϕ', shortcut: 'F' },
    { id: 'fib_extension', name: 'Trend-Based Extension', category: 'overlays', subcategory: 'fib', icon: 'ϕ→' },
    { id: 'fib_channel', name: 'Fib Channel', category: 'overlays', subcategory: 'fib', icon: 'ϕ⫽' },
    { id: 'auto_fib', name: 'Auto-Fib', category: 'overlays', subcategory: 'fib', icon: '⚡ϕ', isNew: true },
    { id: 'ote_zone', name: 'OTE Zone', category: 'overlays', subcategory: 'fib', icon: 'OTE', isNew: true },
    { id: 'fib_time_zone', name: 'Fib Time Zone', category: 'overlays', subcategory: 'fib_time', icon: 'ϕ│' },
    { id: 'fib_time_trend', name: 'Trend-Based Fib Time', category: 'overlays', subcategory: 'fib_time', icon: 'ϕ│→' },
    { id: 'fib_fan', name: 'Speed Resistance Fan', category: 'overlays', subcategory: 'fib_advanced', icon: 'ϕ/' },
    { id: 'fib_arcs', name: 'Speed Resistance Arcs', category: 'overlays', subcategory: 'fib_advanced', icon: 'ϕ(' },
    { id: 'fib_circles', name: 'Fib Circles', category: 'overlays', subcategory: 'fib_advanced', icon: 'ϕ○' },
    { id: 'fib_spiral', name: 'Fib Spiral', category: 'overlays', subcategory: 'fib_advanced', icon: 'ϕ@' },
    { id: 'fib_wedge', name: 'Fib Wedge', category: 'overlays', subcategory: 'fib_advanced', icon: 'ϕ◁' },

    // ═══ OVERLAYS - Gann ═══
    { id: 'gann_fan', name: 'Gann Fan', category: 'overlays', subcategory: 'gann', icon: 'G/' },
    { id: 'gann_box', name: 'Gann Box', category: 'overlays', subcategory: 'gann', icon: 'G▭' },
    { id: 'gann_square', name: 'Gann Square', category: 'overlays', subcategory: 'gann', icon: 'G□' },

    // ═══ OVERLAYS - Volume ═══
    { id: 'anchored_vwap', name: 'Anchored VWAP', category: 'overlays', subcategory: 'volume', icon: 'V' },
    { id: 'vwap_bands', name: 'VWAP Bands', category: 'overlays', subcategory: 'volume', icon: 'Vσ', isNew: true },
    { id: 'session_vwap', name: 'Session VWAP', category: 'overlays', subcategory: 'volume', icon: 'VS', isNew: true },
    { id: 'fixed_range_vp', name: 'Fixed Range VP', category: 'overlays', subcategory: 'volume', icon: 'VP' },
    { id: 'anchored_vp', name: 'Anchored VP', category: 'overlays', subcategory: 'volume', icon: 'VP⚓' },
    { id: 'poc_projection', name: 'POC Projection', category: 'overlays', subcategory: 'volume', icon: 'POC', isNew: true },
    { id: 'value_area', name: 'Value Area', category: 'overlays', subcategory: 'volume', icon: 'VA', isNew: true },

    // ═══ PATTERNS - Harmonic ═══
    { id: 'xabcd_pattern', name: 'XABCD Pattern', category: 'patterns', subcategory: 'harmonic', icon: '◇', shortcut: 'P' },
    { id: 'abcd_pattern', name: 'ABCD Pattern', category: 'patterns', subcategory: 'harmonic', icon: '◇' },
    { id: 'cypher_pattern', name: 'Cypher Pattern', category: 'patterns', subcategory: 'harmonic', icon: '◇' },
    { id: 'three_drives', name: 'Three Drives', category: 'patterns', subcategory: 'harmonic', icon: '◇' },

    // ═══ PATTERNS - Chart ═══
    { id: 'triangle_pattern', name: 'Triangle', category: 'patterns', subcategory: 'chart', icon: '△' },
    { id: 'head_shoulders', name: 'Head & Shoulders', category: 'patterns', subcategory: 'chart', icon: 'M' },
    { id: 'wedge_template', name: 'Wedge Template', category: 'patterns', subcategory: 'chart', icon: '◁', isNew: true },
    { id: 'double_top_bottom', name: 'Double Top/Bottom', category: 'patterns', subcategory: 'chart', icon: 'W', isNew: true },

    // ═══ PATTERNS - Elliott ═══
    { id: 'elliott_impulse', name: 'Impulse (12345)', category: 'patterns', subcategory: 'elliott', icon: '12345' },
    { id: 'elliott_correction', name: 'Correction (ABC)', category: 'patterns', subcategory: 'elliott', icon: 'ABC' },
    { id: 'elliott_triangle', name: 'Triangle (ABCDE)', category: 'patterns', subcategory: 'elliott', icon: 'ABCDE' },
    { id: 'elliott_double', name: 'Double Combo (WXY)', category: 'patterns', subcategory: 'elliott', icon: 'WXY' },
    { id: 'elliott_triple', name: 'Triple Combo (WXYXZ)', category: 'patterns', subcategory: 'elliott', icon: 'WXYXZ' },

    // ═══ PATTERNS - Cycles ═══
    { id: 'cyclic_lines', name: 'Cyclic Lines', category: 'patterns', subcategory: 'cycles', icon: '|||' },
    { id: 'time_cycles', name: 'Time Cycles', category: 'patterns', subcategory: 'cycles', icon: '~' },
    { id: 'sine_line', name: 'Sine Line', category: 'patterns', subcategory: 'cycles', icon: '∿' },

    // ═══ PLAN - Position ═══
    { id: 'long_position', name: 'Long Position', category: 'plan', subcategory: 'position', icon: '📈', shortcut: 'R' },
    { id: 'short_position', name: 'Short Position', category: 'plan', subcategory: 'position', icon: '📉' },
    { id: 'multi_target', name: 'Multi-Target Position', category: 'plan', subcategory: 'position', icon: '🎯', isNew: true },
    { id: 'scaled_entry', name: 'Scaled Entry Position', category: 'plan', subcategory: 'position', icon: '📊', isNew: true },

    // ═══ PLAN - Forecast ═══
    { id: 'forecast', name: 'Forecast Arrow', category: 'plan', subcategory: 'forecast', icon: '→' },
    { id: 'projection', name: 'Projection', category: 'plan', subcategory: 'forecast', icon: '↗' },
    { id: 'bars_pattern', name: 'Bars Pattern', category: 'plan', subcategory: 'forecast', icon: '📋' },
    { id: 'ghost_feed', name: 'Ghost Feed', category: 'plan', subcategory: 'forecast', icon: '👻' },

    // ═══ MEASURE ═══
    { id: 'quick_measure', name: 'Quick Measure', category: 'measure', icon: '📏', shortcut: 'M' },
    { id: 'price_range', name: 'Price Range', category: 'measure', icon: '↕' },
    { id: 'date_range', name: 'Date Range', category: 'measure', icon: '↔' },
    { id: 'combined_range', name: 'Price + Date Range', category: 'measure', icon: '↕↔' },
    { id: 'box_zoom', name: 'Box Zoom', category: 'measure', icon: '🔍' },

    // ═══ ANNOTATE - Text ═══
    { id: 'text', name: 'Text', category: 'annotate', subcategory: 'text', icon: 'T', shortcut: 'A' },
    { id: 'anchored_text', name: 'Anchored Text', category: 'annotate', subcategory: 'text', icon: 'T⚓' },
    { id: 'callout', name: 'Callout', category: 'annotate', subcategory: 'text', icon: '💬' },
    { id: 'note', name: 'Note', category: 'annotate', subcategory: 'text', icon: '📝' },
    { id: 'anchored_note', name: 'Anchored Note', category: 'annotate', subcategory: 'text', icon: '📝⚓' },
    { id: 'comment', name: 'Comment', category: 'annotate', subcategory: 'text', icon: '💭' },

    // ═══ ANNOTATE - Labels ═══
    { id: 'signpost', name: 'Signpost', category: 'annotate', subcategory: 'labels', icon: '🚩' },
    { id: 'flag_mark', name: 'Flag Mark', category: 'annotate', subcategory: 'labels', icon: '⚑' },
    { id: 'pin', name: 'Pin', category: 'annotate', subcategory: 'labels', icon: '📍' },

    // ═══ ANNOTATE - Shapes ═══
    { id: 'circle', name: 'Circle', category: 'annotate', subcategory: 'shapes', icon: '○' },
    { id: 'ellipse', name: 'Ellipse', category: 'annotate', subcategory: 'shapes', icon: '⬭' },
    { id: 'triangle_shape', name: 'Triangle', category: 'annotate', subcategory: 'shapes', icon: '△' },
    { id: 'arc', name: 'Arc', category: 'annotate', subcategory: 'shapes', icon: '⌒' },
    { id: 'curve', name: 'Curve', category: 'annotate', subcategory: 'shapes', icon: '〰' },
    { id: 'double_curve', name: 'Double Curve', category: 'annotate', subcategory: 'shapes', icon: '⟋' },
    { id: 'path', name: 'Path', category: 'annotate', subcategory: 'shapes', icon: '⟋' },
    { id: 'polyline', name: 'Polyline', category: 'annotate', subcategory: 'shapes', icon: '⟋' },
    { id: 'brush', name: 'Brush', category: 'annotate', subcategory: 'shapes', icon: '🖌' },
    { id: 'highlighter', name: 'Highlighter', category: 'annotate', subcategory: 'shapes', icon: '🖍' },

    // ═══ ANNOTATE - Markers ═══
    { id: 'arrow_marker_up', name: 'Arrow Up', category: 'annotate', subcategory: 'markers', icon: '↑' },
    { id: 'arrow_marker_down', name: 'Arrow Down', category: 'annotate', subcategory: 'markers', icon: '↓' },
    { id: 'arrow_marker_left', name: 'Arrow Left', category: 'annotate', subcategory: 'markers', icon: '←' },
    { id: 'arrow_marker_right', name: 'Arrow Right', category: 'annotate', subcategory: 'markers', icon: '→' },
    { id: 'icon', name: 'Icon', category: 'annotate', subcategory: 'markers', icon: '★' },
    { id: 'emoji', name: 'Emoji', category: 'annotate', subcategory: 'markers', icon: '😊' },
    { id: 'sticker', name: 'Sticker', category: 'annotate', subcategory: 'markers', icon: '🎨' },

    // ═══ ANNOTATE - Embed ═══
    { id: 'image', name: 'Image', category: 'annotate', subcategory: 'embed', icon: '🖼' },
    { id: 'table', name: 'Table', category: 'annotate', subcategory: 'embed', icon: '📊' },
    { id: 'price_table', name: 'Price Table', category: 'annotate', subcategory: 'embed', icon: '📊' },
    { id: 'tweet', name: 'Tweet', category: 'annotate', subcategory: 'embed', icon: '🐦' },
    { id: 'idea', name: 'Idea', category: 'annotate', subcategory: 'embed', icon: '💡' },
    { id: 'journal_entry', name: 'Trade Journal Entry', category: 'annotate', subcategory: 'embed', icon: '📓', isNew: true },
];

// Helper: Get tools by category
export const getToolsByCategory = (category: ToolCategory): Tool[] =>
    TOOLS.filter(t => t.category === category);

// Helper: Get tool by ID
export const getToolById = (id: string): Tool | undefined =>
    TOOLS.find(t => t.id === id);

// Helper: Check if tool is in category
export const isToolInCategory = (toolId: string, category: ToolCategory): boolean =>
    TOOLS.some(t => t.id === toolId && t.category === category);

// Helper: Get category for tool
export const getToolCategory = (toolId: string): ToolCategory | undefined =>
    TOOLS.find(t => t.id === toolId)?.category;
