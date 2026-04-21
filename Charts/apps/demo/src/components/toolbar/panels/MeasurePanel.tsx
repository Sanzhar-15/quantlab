// MeasurePanel Component
// Panel for Measure tools

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface MeasurePanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const MeasurePanel: React.FC<MeasurePanelProps> = ({ onClose, onSelectTool }) => {
    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Measure</div>
                <div className="tool-list">
                    <ToolItem id="quick_measure" name="Quick Measure" icon="📏" onSelect={onSelectTool} />
                    <ToolItem id="price_range" name="Price Range" icon="↕" onSelect={onSelectTool} />
                    <ToolItem id="date_range" name="Date Range" icon="↔" onSelect={onSelectTool} />
                    <ToolItem id="combined_range" name="Price + Date Range" icon="↕↔" onSelect={onSelectTool} />
                    <ToolItem id="box_zoom" name="Box Zoom" icon="🔍" onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
