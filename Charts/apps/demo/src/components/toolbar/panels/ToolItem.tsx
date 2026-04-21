// ToolItem Component
// Reusable tool item for panel lists with favorite toggle

import { memo } from 'react';
import { useToolbarStore } from '../toolbarStore';

interface ToolItemProps {
    id: string;
    name: string;
    icon: string;
    isNew?: boolean;
    showFavoriteToggle?: boolean;
    compact?: boolean; // For quick access rows
    onSelect: (id: string) => void;
}

export const ToolItem = memo<ToolItemProps>(({
    id,
    name,
    icon,
    isNew,
    showFavoriteToggle = true,
    compact = false,
    onSelect
}) => {
    const activeTool = useToolbarStore((state) => state.activeTool);
    const favorites = useToolbarStore((state) => state.favorites);
    const addToFavorites = useToolbarStore((state) => state.addToFavorites);
    const removeFromFavorites = useToolbarStore((state) => state.removeFromFavorites);

    const isActive = activeTool === id;
    const isFavorite = favorites.includes(id);

    const handleFavoriteClick = (e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent tool selection
        if (isFavorite) {
            removeFromFavorites(id);
        } else {
            addToFavorites(id);
        }
    };

    return (
        <button
            className={`tool-item ${isActive ? 'tool-item--active' : ''} ${compact ? 'tool-item--compact' : ''}`}
            onClick={() => onSelect(id)}
            title={name}
        >
            <span className="tool-icon">{icon}</span>
            <span className="tool-name">{compact ? name.split(' ')[0] : name}</span>

            {/* Badges Container */}
            <span className="tool-badges">
                {isNew && <span className="tool-badge tool-badge--new">★</span>}
                {showFavoriteToggle && (
                    <span
                        className={`tool-badge tool-badge--favorite ${isFavorite ? 'tool-badge--favorite-active' : ''}`}
                        onClick={handleFavoriteClick}
                        title={isFavorite ? 'Remove from favorites' : 'Add to favorites'}
                    >
                        {isFavorite ? '★' : '☆'}
                    </span>
                )}
            </span>
        </button>
    );
});

ToolItem.displayName = 'ToolItem';
