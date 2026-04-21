// BasePanel Component
// Wrapper for all panels with click-outside and escape handling

import { useEffect, useRef, useCallback } from 'react';

interface BasePanelProps {
    children: React.ReactNode;
    onClose: () => void;
    className?: string;
}

export const BasePanel: React.FC<BasePanelProps> = ({
    children,
    onClose,
    className = '',
}) => {
    const panelRef = useRef<HTMLDivElement>(null);
    // Use ref to ensure stable callback reference for event handlers
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;

    useEffect(() => {
        // Close on click outside
        const handleClickOutside = (event: MouseEvent) => {
            if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
                // Also check if click is inside toolbar
                const toolbar = document.querySelector('.lhs-toolbar__container');
                if (toolbar && toolbar.contains(event.target as Node)) {
                    return; // Don't close if clicking toolbar buttons
                }
                onCloseRef.current();
            }
        };

        // Close on escape
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                onCloseRef.current();
            }
        };

        // Small delay to prevent immediate close from the click that opened it
        const timer = setTimeout(() => {
            document.addEventListener('mousedown', handleClickOutside);
        }, 50);
        document.addEventListener('keydown', handleKeyDown);

        return () => {
            clearTimeout(timer);
            document.removeEventListener('mousedown', handleClickOutside);
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, []); // Empty deps - effect runs once, uses ref for callback

    return (
        <div
            ref={panelRef}
            className={`toolbar-panel ${className}`}
        >
            {children}
        </div>
    );
};
