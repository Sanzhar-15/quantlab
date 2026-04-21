// TrendPanel Component
// Panel for Trend tools: Trend Line, Ray, Extended, Info, Angle, Arrow

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface TrendPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const TrendPanel: React.FC<TrendPanelProps> = ({ onClose, onSelectTool }) => {
    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Trend</div>
                <div className="tool-list">
                    <ToolItem id="trend_line" name="Trend Line" icon="╱" onSelect={onSelectTool} />
                    <ToolItem id="ray" name="Ray" icon="↗" onSelect={onSelectTool} />
                    <ToolItem id="extended_line" name="Extended Line" icon="↔" onSelect={onSelectTool} />
                    <ToolItem id="info_line" name="Info Line" icon="📊" onSelect={onSelectTool} />
                    <ToolItem id="trend_angle" name="Trend Angle" icon="∠" onSelect={onSelectTool} />
                    <ToolItem id="arrow_line" name="Arrow Line" icon="➤" onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
