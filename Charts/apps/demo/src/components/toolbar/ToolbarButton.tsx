// ToolbarButton Component
// Individual toolbar button with click/hold behavior + dropdown arrow

import { useRef, useCallback, useEffect } from 'react';

interface ToolbarButtonProps {
    icon: string;
    tooltip: string;
    isActive?: boolean;
    hasDropdown?: boolean;
    onClick: () => void;
    onHold?: () => void;
    onDropdownClick?: () => void; // Direct click on arrow
}

const HOLD_DELAY = 300; // ms

export const ToolbarButton: React.FC<ToolbarButtonProps> = ({
    icon,
    tooltip,
    isActive = false,
    hasDropdown = false,
    onClick,
    onHold,
    onDropdownClick,
}) => {
    const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const didHoldRef = useRef(false);

    // Cleanup timer on unmount to prevent memory leaks
    useEffect(() => {
        return () => {
            if (holdTimerRef.current) {
                clearTimeout(holdTimerRef.current);
            }
        };
    }, []);

    const handleMouseDown = useCallback(() => {
        didHoldRef.current = false;

        if (onHold) {
            holdTimerRef.current = setTimeout(() => {
                didHoldRef.current = true;
                onHold();
            }, HOLD_DELAY);
        }
    }, [onHold]);

    const handleMouseUp = useCallback(() => {
        if (holdTimerRef.current) {
            clearTimeout(holdTimerRef.current);
            holdTimerRef.current = null;
        }

        if (!didHoldRef.current) {
            onClick();
        }
    }, [onClick]);

    const handleMouseLeave = useCallback(() => {
        if (holdTimerRef.current) {
            clearTimeout(holdTimerRef.current);
            holdTimerRef.current = null;
        }
    }, []);

    // Handle arrow button click (stops propagation to main button)
    const handleArrowClick = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        e.preventDefault();
        onDropdownClick?.();
    }, [onDropdownClick]);

    return (
        <div className={`toolbar-button-wrapper ${hasDropdown ? 'toolbar-button-wrapper--with-dropdown' : ''}`}>
            <button
                className={`toolbar-button ${isActive ? 'toolbar-button--active' : ''}`}
                title={tooltip}
                onMouseDown={handleMouseDown}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseLeave}
            >
                <span className="toolbar-button__icon">{icon}</span>
            </button>
            {hasDropdown && (
                <button
                    className="toolbar-button__arrow"
                    onClick={handleArrowClick}
                    title={`${tooltip} options`}
                >
                    <span className="toolbar-button__arrow-icon">›</span>
                </button>
            )}
        </div>
    );
};

