// Enhanced Search Utility for LHS Toolbar
// Multi-pass search with ranking: exact → prefix → substring

import type { Tool } from '../types';

export interface SearchResult {
    tool: Tool;
    score: number; // Higher = better match
    matchType: 'exact' | 'prefix' | 'word-prefix' | 'category' | 'substring';
}

/**
 * Enhanced search algorithm with intelligent ranking
 * @param tools - Array of all tools
 * @param query - Search query
 * @param limit - Maximum results to return
 * @returns Ranked search results
 */
export function searchTools(tools: Tool[], query: string, limit: number = 8): SearchResult[] {
    if (!query.trim()) return [];

    const normalizedQuery = query.toLowerCase().trim();
    const results: SearchResult[] = [];

    for (const tool of tools) {
        const normalizedId = tool.id.toLowerCase();
        const normalizedName = tool.name.toLowerCase();
        const categoryName = tool.category?.toLowerCase() || '';

        let score = 0;
        let matchType: SearchResult['matchType'] = 'substring';

        // 1. Exact ID match (highest priority) - Score: 100
        if (normalizedId === normalizedQuery) {
            score = 100;
            matchType = 'exact';
        }
        // 2. Exact name match - Score: 95
        else if (normalizedName === normalizedQuery) {
            score = 95;
            matchType = 'exact';
        }
        // 3. ID starts with query - Score: 80
        else if (normalizedId.startsWith(normalizedQuery)) {
            score = 80;
            matchType = 'prefix';
        }
        // 4. Name starts with query - Score: 75
        else if (normalizedName.startsWith(normalizedQuery)) {
            score = 75;
            matchType = 'prefix';
        }
        // 5. Any word in name starts with query - Score: 60
        else if (normalizedName.split(/\s+/).some(word => word.startsWith(normalizedQuery))) {
            score = 60;
            matchType = 'word-prefix';
        }
        // 6. Category match - Score: 40
        else if (categoryName.includes(normalizedQuery)) {
            score = 40;
            matchType = 'category';
        }
        // 7. ID contains query - Score: 30
        else if (normalizedId.includes(normalizedQuery)) {
            score = 30;
            matchType = 'substring';
        }
        // 8. Name contains query - Score: 20
        else if (normalizedName.includes(normalizedQuery)) {
            score = 20;
            matchType = 'substring';
        }
        // No match
        else {
            continue;
        }

        // Bonus points for shorter names (more relevant)
        const lengthBonus = Math.max(0, 10 - tool.name.length / 5);
        score += lengthBonus;

        // Bonus for exact word boundaries
        const words = normalizedName.split(/\s+/);
        if (words.includes(normalizedQuery)) {
            score += 15;
        }

        results.push({ tool, score, matchType });
    }

    // Sort by score (descending) and limit results
    return results
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
}

/**
 * Highlight matching text in a string
 * @param text - Original text
 * @param query - Search query
 * @returns Array of text segments with highlight flags
 */
export function highlightMatch(text: string, query: string): Array<{ text: string; highlight: boolean }> {
    if (!query.trim()) return [{ text, highlight: false }];

    const normalizedText = text.toLowerCase();
    const normalizedQuery = query.toLowerCase().trim();
    const index = normalizedText.indexOf(normalizedQuery);

    if (index === -1) return [{ text, highlight: false }];

    return [
        { text: text.slice(0, index), highlight: false },
        { text: text.slice(index, index + query.length), highlight: true },
        { text: text.slice(index + query.length), highlight: false },
    ].filter(segment => segment.text.length > 0);
}
