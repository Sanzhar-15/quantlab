// DragHandle Component
// Allows vertical repositioning of the floating toolbar

import { useCallback, useRef } from 'react';

interface DragHandleProps {
    position: 'top' | 'bottom';
    onDrag: (deltaY: number) => void;
}

export const DragHandle: React.FC<DragHandleProps> = ({ position, onDrag }) => {
    const isDraggingRef = useRef(false);
    const lastYRef = useRef(0);

    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        isDraggingRef.current = true;
        lastYRef.current = e.clientY;

        const handleMouseMove = (moveEvent: MouseEvent) => {
            if (!isDraggingRef.current) return;
            const deltaY = moveEvent.clientY - lastYRef.current;
            lastYRef.current = moveEvent.clientY;
            onDrag(deltaY);
        };

        const handleMouseUp = () => {
            isDraggingRef.current = false;
            document.removeEventListener('mousemove', handleMouseMove);
            document.removeEventListener('mouseup', handleMouseUp);
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);
    }, [onDrag]);

    return (
        <div
            className={`toolbar-drag-handle toolbar-drag-handle--${position}`}
            onMouseDown={handleMouseDown}
        >
            <span className="toolbar-drag-handle__dots">⋮⋮</span>
        </div>
    );
};
