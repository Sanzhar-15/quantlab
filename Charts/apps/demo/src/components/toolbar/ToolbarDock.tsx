// ToolbarDock Component
// 2x2 control grid + More button

import { useToolbarStore } from './toolbarStore';
import { SnapPanel, LockPanel, VisibilityPanel, DeletePanel, MorePanel } from './panels/ControlPanels';

export const ToolbarDock: React.FC = () => {
    const {
        snapEnabled,
        lockEnabled,
        drawingsVisible,
        eraserMode,
        openPanel,
        toggleSnap,
        toggleLock,
        toggleDrawingsVisible,
        toggleEraser,
        setOpenPanel,
        closePanel,
    } = useToolbarStore();

    const handleRightClick = (panel: 'snap' | 'lock' | 'visibility' | 'delete' | 'more') => (e: React.MouseEvent) => {
        e.preventDefault();
        setOpenPanel(panel);
    };

    return (
        <div className="toolbar-dock">
            {/* 2x2 Grid */}
            <div className="dock-grid">
                {/* Snap */}
                <button
                    className={`dock-button ${snapEnabled ? 'dock-button--active' : ''}`}
                    onClick={toggleSnap}
                    onContextMenu={handleRightClick('snap')}
                    title="Snap (click toggle, right-click options)"
                >
                    🧲
                </button>

                {/* Lock */}
                <button
                    className={`dock-button ${lockEnabled ? 'dock-button--active' : ''}`}
                    onClick={toggleLock}
                    onContextMenu={handleRightClick('lock')}
                    title="Lock (click toggle, right-click options)"
                >
                    🔒
                </button>

                {/* Visibility */}
                <button
                    className={`dock-button ${drawingsVisible ? 'dock-button--active' : ''}`}
                    onClick={toggleDrawingsVisible}
                    onContextMenu={handleRightClick('visibility')}
                    title="Visibility (click toggle, right-click options)"
                >
                    👁
                </button>

                {/* Delete/Eraser */}
                <button
                    className={`dock-button ${eraserMode ? 'dock-button--active' : ''}`}
                    onClick={toggleEraser}
                    onContextMenu={handleRightClick('delete')}
                    title="Delete (click eraser mode, right-click options)"
                >
                    🗑
                </button>
            </div>

            {/* More Button */}
            <button
                className="dock-more-button"
                onClick={() => setOpenPanel('more')}
                title="More options"
            >
                ···
            </button>

            {/* Control Panels */}
            {openPanel === 'snap' && <SnapPanel onClose={closePanel} />}
            {openPanel === 'lock' && <LockPanel onClose={closePanel} />}
            {openPanel === 'visibility' && <VisibilityPanel onClose={closePanel} />}
            {openPanel === 'delete' && <DeletePanel onClose={closePanel} />}
            {openPanel === 'more' && <MorePanel onClose={closePanel} />}
        </div>
    );
};
