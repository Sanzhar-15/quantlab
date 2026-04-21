// Control Panels
// Panels for Snap, Lock, Visibility, Delete, More options

import { BasePanel } from './BasePanel';
import { useToolbarStore } from '../toolbarStore';
import type { SnapStrength, SnapTarget } from '../types';

interface ControlPanelProps {
    onClose: () => void;
}

// ═══ SNAP PANEL ═══
export const SnapPanel: React.FC<ControlPanelProps> = ({ onClose }) => {
    const { snapStrength, snapTargets, setSnapStrength, toggleSnapTarget } = useToolbarStore();

    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Snap Mode</div>
                <div className="tool-list">
                    {(['off', 'weak', 'strong'] as SnapStrength[]).map(strength => (
                        <button
                            key={strength}
                            className={`tool-item ${snapStrength === strength ? 'tool-item--active' : ''}`}
                            onClick={() => setSnapStrength(strength)}
                        >
                            <span className="tool-icon">{strength === 'off' ? '○' : strength === 'weak' ? '◐' : '●'}</span>
                            <span className="tool-name">{strength.charAt(0).toUpperCase() + strength.slice(1)}</span>
                        </button>
                    ))}
                </div>
            </div>

            <div className="panel-section">
                <div className="panel-section-title">Snap To</div>
                <div className="tool-list">
                    {([
                        { id: 'wick', name: 'Wicks (High/Low)', icon: '│' },
                        { id: 'body', name: 'Body (Open/Close)', icon: '▭' },
                        { id: 'close', name: 'Close Only', icon: '─' },
                        { id: 'indicators', name: 'Indicators', icon: '〜' },
                        { id: 'drawings', name: 'Other Drawings', icon: '╱' },
                    ] as { id: SnapTarget; name: string; icon: string }[]).map(target => (
                        <button
                            key={target.id}
                            className={`tool-item ${snapTargets.includes(target.id) ? 'tool-item--active' : ''}`}
                            onClick={() => toggleSnapTarget(target.id)}
                        >
                            <span className="tool-icon">{snapTargets.includes(target.id) ? '☑' : '☐'}</span>
                            <span className="tool-name">{target.name}</span>
                        </button>
                    ))}
                </div>
            </div>
        </BasePanel>
    );
};

// ═══ LOCK PANEL ═══
export const LockPanel: React.FC<ControlPanelProps> = ({ onClose }) => {
    const { lockEnabled, toggleLock } = useToolbarStore();

    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Lock Options</div>
                <div className="tool-list">
                    <button className="tool-item" onClick={toggleLock}>
                        <span className="tool-icon">🔒</span>
                        <span className="tool-name">{lockEnabled ? 'Unlock All' : 'Lock All'}</span>
                    </button>
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">🔒</span>
                        <span className="tool-name">Lock Selected</span>
                    </button>
                </div>
            </div>
        </BasePanel>
    );
};

// ═══ VISIBILITY PANEL ═══
export const VisibilityPanel: React.FC<ControlPanelProps> = ({ onClose }) => {
    const {
        drawingsVisible,
        indicatorsVisible,
        positionsVisible,
        toggleDrawingsVisible,
        toggleIndicatorsVisible,
        togglePositionsVisible,
    } = useToolbarStore();

    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Visibility</div>
                <div className="tool-list">
                    <button
                        className={`tool-item ${drawingsVisible ? 'tool-item--active' : ''}`}
                        onClick={toggleDrawingsVisible}
                    >
                        <span className="tool-icon">{drawingsVisible ? '☑' : '☐'}</span>
                        <span className="tool-name">Drawings</span>
                    </button>
                    <button
                        className={`tool-item ${indicatorsVisible ? 'tool-item--active' : ''}`}
                        onClick={toggleIndicatorsVisible}
                    >
                        <span className="tool-icon">{indicatorsVisible ? '☑' : '☐'}</span>
                        <span className="tool-name">Indicators</span>
                    </button>
                    <button
                        className={`tool-item ${positionsVisible ? 'tool-item--active' : ''}`}
                        onClick={togglePositionsVisible}
                    >
                        <span className="tool-icon">{positionsVisible ? '☑' : '☐'}</span>
                        <span className="tool-name">Positions</span>
                    </button>
                </div>
            </div>
        </BasePanel>
    );
};

// ═══ DELETE PANEL ═══
export const DeletePanel: React.FC<ControlPanelProps> = ({ onClose }) => {
    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Delete Options</div>
                <div className="tool-list">
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">🗑</span>
                        <span className="tool-name">Delete Selected</span>
                    </button>
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">🗑</span>
                        <span className="tool-name">Delete All Drawings</span>
                    </button>
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">🗑</span>
                        <span className="tool-name">Clear on Symbol Change</span>
                    </button>
                </div>
            </div>
        </BasePanel>
    );
};

// ═══ MORE PANEL ═══
export const MorePanel: React.FC<ControlPanelProps> = ({ onClose }) => {
    const { stayInDrawingMode, setStayInDrawingMode } = useToolbarStore();

    return (
        <BasePanel onClose={onClose}>
            <div className="panel-section">
                <div className="panel-section-title">Settings</div>
                <div className="tool-list">
                    <button
                        className={`tool-item ${stayInDrawingMode ? 'tool-item--active' : ''}`}
                        onClick={() => setStayInDrawingMode(!stayInDrawingMode)}
                    >
                        <span className="tool-icon">{stayInDrawingMode ? '☑' : '☐'}</span>
                        <span className="tool-name">Stay in Drawing Mode</span>
                    </button>
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">🌐</span>
                        <span className="tool-name">Sync Settings</span>
                    </button>
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">🌳</span>
                        <span className="tool-name">Object Tree</span>
                    </button>
                    <button className="tool-item" onClick={onClose}>
                        <span className="tool-icon">⚙</span>
                        <span className="tool-name">Toolbar Settings</span>
                    </button>
                </div>
            </div>
        </BasePanel>
    );
};
