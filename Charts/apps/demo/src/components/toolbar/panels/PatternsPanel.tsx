// PatternsPanel Component
// Panel with Quick Access, Harmonic, Chart Patterns, Elliott, Cycles

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';
import { useToolbarStore } from '../toolbarStore';

interface PatternsPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const PatternsPanel: React.FC<PatternsPanelProps> = ({ onClose, onSelectTool }) => {
    const activeTool = useToolbarStore((state) => state.activeTool);

    return (
        <BasePanel onClose={onClose}>
            {/* Quick Access Row */}
            <div className="panel-section">
                <div className="panel-section-title">Quick Access</div>
                <div className="quick-access-row">
                    <button
                        className={`tool-item ${activeTool === 'triangle_pattern' ? 'tool-item--active' : ''}`}
                        onClick={() => onSelectTool('triangle_pattern')}
                    >
                        <span className="tool-icon">△</span>
                        <span className="tool-name">Triangle</span>
                    </button>
                    <button
                        className={`tool-item ${activeTool === 'xabcd_pattern' ? 'tool-item--active' : ''}`}
                        onClick={() => onSelectTool('xabcd_pattern')}
                    >
                        <span className="tool-icon">◇</span>
                        <span className="tool-name">XABCD</span>
                    </button>
                    <button
                        className={`tool-item ${activeTool === 'elliott_impulse' ? 'tool-item--active' : ''}`}
                        onClick={() => onSelectTool('elliott_impulse')}
                    >
                        <span className="tool-icon">12345</span>
                        <span className="tool-name">Impulse</span>
                    </button>
                </div>
            </div>

            {/* Harmonic */}
            <div className="panel-section">
                <div className="panel-section-title">Harmonic</div>
                <div className="tool-list">
                    <ToolItem id="xabcd_pattern" name="XABCD Pattern" icon="◇" onSelect={onSelectTool} />
                    <ToolItem id="abcd_pattern" name="ABCD Pattern" icon="◇" onSelect={onSelectTool} />
                    <ToolItem id="cypher_pattern" name="Cypher Pattern" icon="◇" onSelect={onSelectTool} />
                    <ToolItem id="three_drives" name="Three Drives" icon="◇" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Chart Patterns */}
            <div className="panel-section">
                <div className="panel-section-title">Chart Patterns</div>
                <div className="tool-list">
                    <ToolItem id="triangle_pattern" name="Triangle" icon="△" onSelect={onSelectTool} />
                    <ToolItem id="head_shoulders" name="Head & Shoulders" icon="M" onSelect={onSelectTool} />
                    <ToolItem id="wedge_template" name="Wedge Template" icon="◁" isNew onSelect={onSelectTool} />
                    <ToolItem id="double_top_bottom" name="Double Top/Bottom" icon="W" isNew onSelect={onSelectTool} />
                </div>
            </div>

            {/* Elliott Wave */}
            <div className="panel-section">
                <div className="panel-section-title">Elliott Wave</div>
                <div className="tool-list">
                    <ToolItem id="elliott_impulse" name="Impulse (12345)" icon="12345" onSelect={onSelectTool} />
                    <ToolItem id="elliott_correction" name="Correction (ABC)" icon="ABC" onSelect={onSelectTool} />
                    <ToolItem id="elliott_triangle" name="Triangle (ABCDE)" icon="ABCDE" onSelect={onSelectTool} />
                    <ToolItem id="elliott_double" name="Double Combo (WXY)" icon="WXY" onSelect={onSelectTool} />
                    <ToolItem id="elliott_triple" name="Triple Combo (WXYXZ)" icon="WXYXZ" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Cycles */}
            <div className="panel-section">
                <div className="panel-section-title">Cycles</div>
                <div className="tool-list">
                    <ToolItem id="cyclic_lines" name="Cyclic Lines" icon="|||" onSelect={onSelectTool} />
                    <ToolItem id="time_cycles" name="Time Cycles" icon="~" onSelect={onSelectTool} />
                    <ToolItem id="sine_line" name="Sine Line" icon="∿" onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
