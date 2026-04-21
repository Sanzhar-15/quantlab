// HubPanel Component
// Search, Recents, Favorites, Cursor Mode

import { useState, useRef, useEffect } from 'react';
import { BasePanel } from './BasePanel';
import { useToolbarStore } from '../toolbarStore';
import { TOOLS, getToolById } from '../toolDefinitions';
import { searchTools, highlightMatch } from '../utils/searchTools';
import type { CursorMode } from '../types';

interface HubPanelProps {
    onClose: () => void;
    onSelectTool: (toolId: string) => void;
}

export const HubPanel: React.FC<HubPanelProps> = ({ onClose, onSelectTool }) => {
    const [searchQuery, setSearchQuery] = useState('');
    const [selectedIndex, setSelectedIndex] = useState(0);
    const searchInputRef = useRef<HTMLInputElement>(null);

    const {
        recentTools,
        favorites,
        cursorMode,
        setCursorMode,
        addToFavorites,
        removeFromFavorites,
    } = useToolbarStore();

    // Focus search input on mount
    useEffect(() => {
        searchInputRef.current?.focus();
    }, []);

    // Enhanced search with ranking
    const searchResults = searchQuery.trim()
        ? searchTools(TOOLS, searchQuery, 8)
        : [];

    // Reset selected index when search changes
    useEffect(() => {
        setSelectedIndex(0);
    }, [searchQuery]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (searchResults.length === 0 && e.key !== 'Escape') return;

        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                setSelectedIndex(prev => (prev + 1) % searchResults.length);
                break;
            case 'ArrowUp':
                e.preventDefault();
                setSelectedIndex(prev => (prev - 1 + searchResults.length) % searchResults.length);
                break;
            case 'Enter':
                e.preventDefault();
                if (searchResults[selectedIndex]) {
                    onSelectTool(searchResults[selectedIndex].tool.id);
                }
                break;
            case 'Escape':
                e.preventDefault();
                if (searchQuery) {
                    setSearchQuery('');
                } else {
                    onClose();
                }
                break;
        }
    };

    const toggleFavorite = (toolId: string) => {
        if (favorites.includes(toolId)) {
            removeFromFavorites(toolId);
        } else {
            addToFavorites(toolId);
        }
    };

    return (
        <BasePanel onClose={onClose} className="hub-panel">
            {/* Search */}
            <div className="hub-search">
                <span className="hub-search__icon">🔍</span>
                <input
                    ref={searchInputRef}
                    type="text"
                    className="hub-search__input"
                    placeholder="Search tools..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onKeyDown={handleKeyDown}
                />
            </div>

            {/* Search Results */}
            {searchResults.length > 0 && (
                <div className="panel-section">
                    <div className="panel-section-title">Results</div>
                    <div className="tool-list">
                        {searchResults.map((result, index) => {
                            const tool = result.tool;
                            const isSelected = index === selectedIndex;
                            const nameSegments = highlightMatch(tool.name, searchQuery);

                            return (
                                <button
                                    key={tool.id}
                                    className={`tool-item ${isSelected ? 'tool-item--selected' : ''}`}
                                    onClick={() => onSelectTool(tool.id)}
                                    onMouseEnter={() => setSelectedIndex(index)}
                                >
                                    <span className="tool-icon">{tool.icon}</span>
                                    <span className="tool-name">
                                        {nameSegments.map((segment, i) => (
                                            <span
                                                key={i}
                                                className={segment.highlight ? 'highlight' : ''}
                                            >
                                                {segment.text}
                                            </span>
                                        ))}
                                    </span>
                                    <span className="tool-badges">
                                        {tool.isNew && <span className="tool-badge tool-badge--new">★</span>}
                                        <span className="tool-category-badge">{tool.category}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            )}

            {/* Recents (only show if no search) */}
            {!searchQuery && (
                <div className="panel-section">
                    <div className="panel-section-header">
                        <div className="panel-section-title">Recents</div>
                        {recentTools.length > 0 && (
                            <button
                                className="panel-section-action"
                                onClick={() => {
                                    // Clear recents by setting empty array
                                    useToolbarStore.setState({ recentTools: [] });
                                }}
                                title="Clear recents"
                            >
                                Clear
                            </button>
                        )}
                    </div>
                    {recentTools.length > 0 ? (
                        <div className="quick-access-row">
                            {recentTools.slice(0, 4).map(toolId => {
                                const tool = getToolById(toolId);
                                if (!tool) return null;
                                return (
                                    <button
                                        key={toolId}
                                        className="tool-item tool-item--compact"
                                        onClick={() => onSelectTool(toolId)}
                                        title={tool.name}
                                    >
                                        <span className="tool-icon">{tool.icon}</span>
                                        <span className="tool-name">{tool.name.split(' ')[0]}</span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <span className="empty-state__icon">🕒</span>
                            <span className="empty-state__text">No recent tools yet</span>
                        </div>
                    )}
                </div>
            )}

            {/* Favorites (only show if no search) */}
            {!searchQuery && (
                <div className="panel-section">
                    <div className="panel-section-title">Favorites</div>
                    {favorites.length > 0 ? (
                        <div className="favorites-grid">
                            {favorites.map(toolId => {
                                const tool = getToolById(toolId);
                                if (!tool) return null;
                                return (
                                    <button
                                        key={toolId}
                                        className="tool-item tool-item--grid"
                                        onClick={() => onSelectTool(toolId)}
                                        title={tool.name}
                                    >
                                        <span className="tool-icon">{tool.icon}</span>
                                        <span className="tool-name">{tool.name}</span>
                                        <span
                                            className="tool-badge tool-badge--favorite tool-badge--favorite-active tool-remove"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                toggleFavorite(toolId);
                                            }}
                                            title="Remove from favorites"
                                        >
                                            ×
                                        </span>
                                    </button>
                                );
                            })}
                        </div>
                    ) : (
                        <div className="empty-state">
                            <span className="empty-state__icon">⭐</span>
                            <span className="empty-state__text">No favorites yet</span>
                            <span className="empty-state__hint">Star tools to add them here</span>
                        </div>
                    )}
                </div>
            )}

            {/* Cursor Mode (only show if no search) */}
            {!searchQuery && (
                <div className="panel-section">
                    <div className="panel-section-title">Cursor</div>
                    <div className="cursor-modes">
                        {(['crosshair', 'arrow', 'dot', 'demo'] as CursorMode[]).map(mode => (
                            <button
                                key={mode}
                                className={`cursor-mode ${cursorMode === mode ? 'cursor-mode--active' : ''}`}
                                onClick={() => setCursorMode(mode)}
                            >
                                {mode === 'crosshair' && '┼'}
                                {mode === 'arrow' && '➤'}
                                {mode === 'dot' && '●'}
                                {mode === 'demo' && '▶'}
                                <br />
                                <small>{mode}</small>
                            </button>
                        ))}
                    </div>
                </div>
            )}
        </BasePanel>
    );
};
