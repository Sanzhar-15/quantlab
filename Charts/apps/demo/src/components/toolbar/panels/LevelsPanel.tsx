// LevelsPanel Component
// Panel for Levels tools: H-Line, H-Ray, V-Line, Cross, Price Label

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface LevelsPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const LevelsPanel: React.FC<LevelsPanelProps> = ({ onClose, onSelectTool }) => {
    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Levels</div>
                <div className="tool-list">
                    <ToolItem id="h_line" name="Horizontal Line" icon="─" onSelect={onSelectTool} />
                    <ToolItem id="h_ray" name="Horizontal Ray" icon="→" onSelect={onSelectTool} />
                    <ToolItem id="v_line" name="Vertical Line" icon="│" onSelect={onSelectTool} />
                    <ToolItem id="cross_line" name="Cross Line" icon="┼" onSelect={onSelectTool} />
                    <ToolItem id="price_label" name="Price Label" icon="●" onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
