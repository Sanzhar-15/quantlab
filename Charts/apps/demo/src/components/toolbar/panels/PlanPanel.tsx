// PlanPanel Component
// Panel for Position and Forecast tools

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface PlanPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const PlanPanel: React.FC<PlanPanelProps> = ({ onClose, onSelectTool }) => {
    return (
        <BasePanel onClose={onClose}>
            {/* Position Tools */}
            <div className="panel-section">
                <div className="panel-section-title">Position Tools</div>
                <div className="tool-list">
                    <ToolItem id="long_position" name="Long Position" icon="📈" onSelect={onSelectTool} />
                    <ToolItem id="short_position" name="Short Position" icon="📉" onSelect={onSelectTool} />
                    <ToolItem id="multi_target" name="Multi-Target Position" icon="🎯" isNew onSelect={onSelectTool} />
                    <ToolItem id="scaled_entry" name="Scaled Entry Position" icon="📊" isNew onSelect={onSelectTool} />
                </div>
            </div>

            {/* Forecast */}
            <div className="panel-section">
                <div className="panel-section-title">Forecast</div>
                <div className="tool-list">
                    <ToolItem id="forecast" name="Forecast Arrow" icon="→" onSelect={onSelectTool} />
                    <ToolItem id="projection" name="Projection" icon="↗" onSelect={onSelectTool} />
                    <ToolItem id="bars_pattern" name="Bars Pattern" icon="📋" onSelect={onSelectTool} />
                    <ToolItem id="ghost_feed" name="Ghost Feed" icon="👻" onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
