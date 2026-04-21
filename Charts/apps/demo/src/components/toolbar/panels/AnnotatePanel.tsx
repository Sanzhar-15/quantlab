// AnnotatePanel Component
// Panel for Text, Labels, Shapes, Markers, Embed

import { BasePanel } from './BasePanel';
import { ToolItem } from './ToolItem';

interface AnnotatePanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const AnnotatePanel: React.FC<AnnotatePanelProps> = ({ onClose, onSelectTool }) => {
    return (
        <BasePanel onClose={onClose}>
            {/* Text */}
            <div className="panel-section">
                <div className="panel-section-title">Text</div>
                <div className="tool-list">
                    <ToolItem id="text" name="Text" icon="T" onSelect={onSelectTool} />
                    <ToolItem id="anchored_text" name="Anchored Text" icon="T⚓" onSelect={onSelectTool} />
                    <ToolItem id="callout" name="Callout" icon="💬" onSelect={onSelectTool} />
                    <ToolItem id="note" name="Note" icon="📝" onSelect={onSelectTool} />
                    <ToolItem id="comment" name="Comment" icon="💭" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Labels */}
            <div className="panel-section">
                <div className="panel-section-title">Labels</div>
                <div className="tool-list">
                    <ToolItem id="signpost" name="Signpost" icon="🚩" onSelect={onSelectTool} />
                    <ToolItem id="flag_mark" name="Flag Mark" icon="⚑" onSelect={onSelectTool} />
                    <ToolItem id="pin" name="Pin" icon="📍" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Shapes */}
            <div className="panel-section">
                <div className="panel-section-title">Shapes</div>
                <div className="tool-list">
                    <ToolItem id="circle" name="Circle" icon="○" onSelect={onSelectTool} />
                    <ToolItem id="ellipse" name="Ellipse" icon="⬭" onSelect={onSelectTool} />
                    <ToolItem id="triangle_shape" name="Triangle" icon="△" onSelect={onSelectTool} />
                    <ToolItem id="arc" name="Arc" icon="⌒" onSelect={onSelectTool} />
                    <ToolItem id="brush" name="Brush" icon="🖌" onSelect={onSelectTool} />
                    <ToolItem id="highlighter" name="Highlighter" icon="🖍" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Markers */}
            <div className="panel-section">
                <div className="panel-section-title">Markers</div>
                <div className="tool-list">
                    <ToolItem id="arrow_marker_up" name="Arrow Up" icon="↑" onSelect={onSelectTool} />
                    <ToolItem id="arrow_marker_down" name="Arrow Down" icon="↓" onSelect={onSelectTool} />
                    <ToolItem id="icon" name="Icon" icon="★" onSelect={onSelectTool} />
                    <ToolItem id="emoji" name="Emoji" icon="😊" onSelect={onSelectTool} />
                </div>
            </div>

            {/* Embed */}
            <div className="panel-section">
                <div className="panel-section-title">Embed</div>
                <div className="tool-list">
                    <ToolItem id="image" name="Image" icon="🖼" onSelect={onSelectTool} />
                    <ToolItem id="table" name="Table" icon="📊" onSelect={onSelectTool} />
                    <ToolItem id="journal_entry" name="Trade Journal Entry" icon="📓" isNew onSelect={onSelectTool} />
                </div>
            </div>
        </BasePanel>
    );
};
