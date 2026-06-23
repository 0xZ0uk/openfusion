export interface SearchResult {
    title: string;
    snippet: string;
    url: string;
}
/**
 * Web search with Brave Search API (primary) → DuckDuckGo instant answer (fallback).
 */
export declare function searchWeb(query: string): Promise<SearchResult[]>;
//# sourceMappingURL=search.d.ts.map