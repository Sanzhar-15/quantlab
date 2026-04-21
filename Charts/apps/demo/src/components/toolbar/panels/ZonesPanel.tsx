// ZonesPanel Component
// Panel for Zones: Basic, Smart Zones, Session

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface ZonesPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const ZonesPanel: React.FC<ZonesPanelProps> = ({ onClose, onSelectTool }) => {
    return (
        <BasePanel onClose={onClose}>
            {/* Basic */}
            <div className="panel-section">
                <div className="panel-section-title">Basic</div>
                <div className="tool-list">
                    <ToolItem id="rectangle" name="Rectangle" icon="▭" onSelect={onSelectTool} />
                    <ToolItem id="rotated_rectangle" name="Rotated Rectangle" icon="◇" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Smart Zones */}
            <div className="panel-section">
                <div className="panel-section-title">Smart Zones</div>
                <div className="tool-list">
                    <ToolItem id="supply_demand_zone" name="Supply/Demand Zone" icon="S/D" isNew onSelect={onSelectTool} />
                    <ToolItem id="order_block" name="Order Block" icon="OB" isNew onSelect={onSelectTool} />
                    <ToolItem id="fair_value_gap" name="Fair Value Gap" icon="FVG" isNew onSelect={onSelectTool} />
                    <ToolItem id="breaker_block" name="Breaker Block" icon="BB" isNew onSelect={onSelectTool} />
                </div>
            </div>

            {/* Session */}
            <div className="panel-section">
                <div className="panel-section-title">Session</div>
                <div className="tool-list">
                    <ToolItem id="session_box" name="Session Box" icon="🌏" isNew onSelect={onSelectTool} />
                    <ToolItem id="opening_range" name="Opening Range" icon="OR" isNew onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
