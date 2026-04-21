// LHSToolbar - Main Toolbar Container
// Based on LHS_BAR_ARCHITECTURE.md specification

import { useState, useCallback } from 'react';
import { useToolbarStore } from './toolbarStore';
import { DragHandle } from './DragHandle';
import { ToolbarButton } from './ToolbarButton';
import { ToolbarSection } from './ToolbarSection';
import { ToolbarDock } from './ToolbarDock';
import { BasePanel } from './panels/BasePanel';
import { LevelsPanel } from './panels/LevelsPanel';
import { TrendPanel } from './panels/TrendPanel';
import { StructurePanel } from './panels/StructurePanel';
import { ZonesPanel } from './panels/ZonesPanel';
import { OverlaysPanel } from './panels/OverlaysPanel';
import { PatternsPanel } from './panels/PatternsPanel';
import { PlanPanel } from './panels/PlanPanel';
import { MeasurePanel } from './panels/MeasurePanel';
import { AnnotatePanel } from './panels/AnnotatePanel';
import { HubPanel } from './panels/HubPanel';
import type { ToolCategory } from './types';
import { isToolInCategory, getToolCategory } from './toolDefinitions';
import './LHSToolbar.css';

interface LHSToolbarProps {
    onToolSelect?: (toolId: string) => void;
    className?: string;
}

export const LHSToolbar: React.FC<LHSToolbarProps> = ({ onToolSelect, className }) => {
    const [positionY, setPositionY] = useState(100);

    const {
        activeTool,
        lastUsed,
        openPanel,
        setActiveTool,
        setLastUsed,
        setOpenPanel,
        closePanel,
    } = useToolbarStore();

    // Handle button click (activate last-used tool)
    const handleButtonClick = useCallback((category: ToolCategory) => {
        const toolId = lastUsed[category];
        setActiveTool(toolId);
        setLastUsed(category, toolId);
        closePanel();
        onToolSelect?.(toolId);
    }, [lastUsed, setActiveTool, setLastUsed, closePanel, onToolSelect]);

    // Handle button hold (open panel)
    const handleButtonHold = useCallback((panel: ToolCategory | 'hub') => {
        setOpenPanel(panel);
    }, [setOpenPanel]);

    // Handle tool selection from panel
    const handleToolSelect = useCallback((toolId: string) => {
        const category = getToolCategory(toolId);
        if (category) {
            setLastUsed(category, toolId);
        }
        setActiveTool(toolId);
        closePanel();
        onToolSelect?.(toolId);
    }, [setLastUsed, setActiveTool, closePanel, onToolSelect]);

    // Handle drag
    const handleDrag = useCallback((deltaY: number) => {
        setPositionY((prev) => Math.max(60, Math.min(window.innerHeight - 500, prev + deltaY)));
    }, []);

    // Check if a tool in a category is active
    const isCategoryActive = useCallback((category: ToolCategory): boolean => {
        return activeTool ? isToolInCategory(activeTool, category) : false;
    }, [activeTool]);

    return (
        <div
            className={`lhs-toolbar ${className || ''}`}
            style={{ top: positionY }}
        >
            {/* Top Drag Handle */}
            <DragHandle position="top" onDrag={handleDrag} />

            <div className="lhs-toolbar__container">
                {/* ══ SECTION A: META ══ */}
                <ToolbarButton
                    icon="🔍"
                    tooltip="Hub (⌘K)"
                    isActive={openPanel === 'hub'}
                    onClick={() => setOpenPanel('hub')}
                    onHold={() => setOpenPanel('hub')}
                />
                {openPanel === 'hub' && (
                    <HubPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarSection />

                {/* ══ SECTION B: MARK ══ */}
                <ToolbarButton
                    icon="─"
                    tooltip="Levels (L)"
                    isActive={isCategoryActive('levels')}
                    hasDropdown
                    onClick={() => handleButtonClick('levels')}
                    onHold={() => handleButtonHold('levels')}
                    onDropdownClick={() => handleButtonHold('levels')}
                />
                {openPanel === 'levels' && (
                    <LevelsPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarButton
                    icon="╱"
                    tooltip="Trend (T)"
                    isActive={isCategoryActive('trend')}
                    hasDropdown
                    onClick={() => handleButtonClick('trend')}
                    onHold={() => handleButtonHold('trend')}
                    onDropdownClick={() => handleButtonHold('trend')}
                />
                {openPanel === 'trend' && (
                    <TrendPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarButton
                    icon="⫽"
                    tooltip="Structure (S)"
                    isActive={isCategoryActive('structure')}
                    hasDropdown
                    onClick={() => handleButtonClick('structure')}
                    onHold={() => handleButtonHold('structure')}
                    onDropdownClick={() => handleButtonHold('structure')}
                />
                {openPanel === 'structure' && (
                    <StructurePanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarButton
                    icon="▭"
                    tooltip="Zones (Z)"
                    isActive={isCategoryActive('zones')}
                    hasDropdown
                    onClick={() => handleButtonClick('zones')}
                    onHold={() => handleButtonHold('zones')}
                    onDropdownClick={() => handleButtonHold('zones')}
                />
                {openPanel === 'zones' && (
                    <ZonesPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarSection />

                {/* ══ SECTION C: ANALYZE ══ */}
                <ToolbarButton
                    icon="ϕ"
                    tooltip="Overlays (F)"
                    isActive={isCategoryActive('overlays')}
                    hasDropdown
                    onClick={() => handleButtonClick('overlays')}
                    onHold={() => handleButtonHold('overlays')}
                    onDropdownClick={() => handleButtonHold('overlays')}
                />
                {openPanel === 'overlays' && (
                    <OverlaysPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarButton
                    icon="◇"
                    tooltip="Patterns (P)"
                    isActive={isCategoryActive('patterns')}
                    hasDropdown
                    onClick={() => handleButtonClick('patterns')}
                    onHold={() => handleButtonHold('patterns')}
                    onDropdownClick={() => handleButtonHold('patterns')}
                />
                {openPanel === 'patterns' && (
                    <PatternsPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarSection />

                {/* ══ SECTION D: EXECUTE ══ */}
                <ToolbarButton
                    icon="◎"
                    tooltip="Plan (R)"
                    isActive={isCategoryActive('plan')}
                    hasDropdown
                    onClick={() => handleButtonClick('plan')}
                    onHold={() => handleButtonHold('plan')}
                    onDropdownClick={() => handleButtonHold('plan')}
                />
                {openPanel === 'plan' && (
                    <PlanPanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarButton
                    icon="📏"
                    tooltip="Measure (M)"
                    isActive={isCategoryActive('measure')}
                    hasDropdown
                    onClick={() => handleButtonClick('measure')}
                    onHold={() => handleButtonHold('measure')}
                    onDropdownClick={() => handleButtonHold('measure')}
                />
                {openPanel === 'measure' && (
                    <MeasurePanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarSection />

                {/* ══ SECTION E: ANNOTATE ══ */}
                <ToolbarButton
                    icon="T"
                    tooltip="Annotate (A)"
                    isActive={isCategoryActive('annotate')}
                    hasDropdown
                    onClick={() => handleButtonClick('annotate')}
                    onHold={() => handleButtonHold('annotate')}
                    onDropdownClick={() => handleButtonHold('annotate')}
                />
                {openPanel === 'annotate' && (
                    <AnnotatePanel onClose={closePanel} onSelectTool={handleToolSelect} />
                )}

                <ToolbarSection variant="heavy" />

                {/* ══ SECTION F: CONTROL ══ */}
                <ToolbarDock />
            </div>

            {/* Bottom Drag Handle */}
            <DragHandle position="bottom" onDrag={handleDrag} />
        </div>
    );
};
