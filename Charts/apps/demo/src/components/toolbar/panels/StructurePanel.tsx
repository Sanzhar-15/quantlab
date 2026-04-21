// StructurePanel Component
// Panel with Quick Access row, Channels, Pitchforks, Market Structure sections

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';
import { useToolbarStore } from '../toolbarStore';

interface StructurePanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const StructurePanel: React.FC<StructurePanelProps> = ({ onClose, onSelectTool }) => {
    const activeTool = useToolbarStore((state) => state.activeTool);

    return (
        <BasePanel onClose={onClose}>
            {/* Quick Access Row */}
            <div className="panel-section">
                <div className="panel-section-title">Quick Access</div>
                <div className="quick-access-row">
                    <button
                        className={`tool-item ${activeTool === 'parallel_channel' ? 'tool-item--active' : ''}`}
                        onClick={() => onSelectTool('parallel_channel')}
                    >
                        <span className="tool-icon">⫽</span>
                        <span className="tool-name">Parallel</span>
                    </button>
                    <button
                        className={`tool-item ${activeTool === 'pitchfork' ? 'tool-item--active' : ''}`}
                        onClick={() => onSelectTool('pitchfork')}
                    >
                        <span className="tool-icon">⋔</span>
                        <span className="tool-name">Pitchfork</span>
                    </button>
                    <button
                        className={`tool-item ${activeTool === 'swing_label' ? 'tool-item--active' : ''}`}
                        onClick={() => onSelectTool('swing_label')}
                    >
                        <span className="tool-icon">⟰</span>
                        <span className="tool-name">Swing</span>
                    </button>
                </div>
            </div>

            {/* Channels */}
            <div className="panel-section">
                <div className="panel-section-title">Channels</div>
                <div className="tool-list">
                    <ToolItem id="parallel_channel" name="Parallel Channel" icon="⫽" onSelect={onSelectTool} />
                    <ToolItem id="regression_trend" name="Regression Trend" icon="📈" onSelect={onSelectTool} />
                    <ToolItem id="flat_top_bottom" name="Flat Top/Bottom" icon="⌐" onSelect={onSelectTool} />
                    <ToolItem id="disjoint_channel" name="Disjoint Channel" icon="⫽" onSelect={onSelectTool} />
                    <ToolItem id="std_dev_channel" name="Std Deviation Channel" icon="σ" isNew onSelect={onSelectTool} />
                </div>
            </div>

            {/* Pitchforks */}
            <div className="panel-section">
                <div className="panel-section-title">Pitchforks</div>
                <div className="tool-list">
                    <ToolItem id="pitchfork" name="Andrews' Pitchfork" icon="⋔" onSelect={onSelectTool} />
                    <ToolItem id="schiff_pitchfork" name="Schiff Pitchfork" icon="⋔" onSelect={onSelectTool} />
                    <ToolItem id="modified_schiff" name="Modified Schiff" icon="⋔" onSelect={onSelectTool} />
                    <ToolItem id="inside_pitchfork" name="Inside Pitchfork" icon="⋔" onSelect={onSelectTool} />
                    <ToolItem id="pitchfan" name="Pitchfan" icon="⋔" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Market Structure */}
            <div className="panel-section">
                <div className="panel-section-title">Market Structure</div>
                <div className="tool-list">
                    <ToolItem id="swing_label" name="Swing High/Low" icon="⟰" isNew onSelect={onSelectTool} />
                    <ToolItem id="bos_marker" name="BOS Marker" icon="⚡" isNew onSelect={onSelectTool} />
                    <ToolItem id="choch_marker" name="CHoCH Marker" icon="↻" isNew onSelect={onSelectTool} />
                    <ToolItem id="invalidation_zone" name="Invalidation Zone" icon="▢" isNew onSelect={onSelectTool} />
                    <ToolItem id="liquidity_sweep" name="Liquidity Sweep" icon="💧" isNew onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
