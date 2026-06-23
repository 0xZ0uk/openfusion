import { config } from "./config.js";
import { createModuleLogger } from "./logger.js";

const log = createModuleLogger("search");

export interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

export const SEARCH_TOOL = {
  type: "function" as const,
  function: {
    name: "search_web",
    description:
      "Search the web for current information. Use this when you need facts, recent events, or information beyond your training data to answer the user's query accurately.",
    parameters: {
      type: "object" as const,
      properties: {
        query: {
          type: "string",
          description: "The search query to look up",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * Web search with Brave Search API (primary) → DuckDuckGo instant answer (fallback).
 */
export async function searchWeb(query: string): Promise<SearchResult[]> {
  log.info("Searching web", { query: query.slice(0, 120) });

  // Try Brave first if API key is set
  if (config.search.braveApiKey) {
    try {
      const results = await braveSearch(query);
      log.info("Brave search complete", { count: results.length });
      if (results.length > 0) return results;
    } catch (err) {
      log.warn("Brave failed, falling back to DDG", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Fall back to DuckDuckGo
  try {
    const results = await ddgSearch(query);
    log.info("DDG search complete", { count: results.length });
    return results;
  } catch (err) {
    log.error("DDG fallback also failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

// ---- Brave Search API ----

async function braveSearch(query: string): Promise<SearchResult[]> {
  const url = new URL("https://api.search.brave.com/res/v1/web/search");
  url.searchParams.set("q", query);
  url.searchParams.set("count", "8");
  url.searchParams.set("safesearch", "moderate");

  const resp = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": config.search.braveApiKey!,
    },
  });

  if (!resp.ok) {
    throw new Error(`Brave API returned ${resp.status}: ${await resp.text().catch(() => "unknown")}`);
  }

  const data = (await resp.json()) as {
    web?: {
      results?: Array<{
        title: string;
        description: string;
        url: string;
      }>;
    };
  };

  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    snippet: r.description ?? "",
    url: r.url ?? "",
  }));
}

// ---- DuckDuckGo fallback (instant answer API) ----

interface DDGResponse {
  AbstractText?: string;
  AbstractSource?: string;
  AbstractURL?: string;
  RelatedTopics?: Array<{
    Text?: string;
    FirstURL?: string;
    Result?: string;
    Topics?: Array<{
      Text?: string;
      FirstURL?: string;
      Result?: string;
    }>;
  }>;
  Results?: Array<{
    Text?: string;
    FirstURL?: string;
    Result?: string;
  }>;
}

async function ddgSearch(query: string): Promise<SearchResult[]> {
  const url = new URL("https://api.duckduckgo.com/");
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");
  url.searchParams.set("no_html", "1");
  url.searchParams.set("skip_disambig", "1");

  const resp = await fetch(url.toString(), {
    headers: { Accept: "application/json" },
  });

  if (!resp.ok) {
    throw new Error(`DDG API returned ${resp.status}`);
  }

  const data = (await resp.json()) as DDGResponse;
  const results: SearchResult[] = [];

  // Abstract/instant answer
  if (data.AbstractText) {
    results.push({
      title: data.AbstractSource ?? "DuckDuckGo",
      snippet: data.AbstractText,
      url: data.AbstractURL ?? "",
    });
  }

  // Related topics
  if (data.RelatedTopics) {
    for (const topic of data.RelatedTopics) {
      if (topic.Topics) {
        for (const sub of topic.Topics) {
          if (sub.Text) {
            results.push({
              title: sub.Text.split(" - ")[0] ?? sub.Text.slice(0, 80),
              snippet: sub.Text,
              url: sub.FirstURL ?? "",
            });
          }
        }
      } else if (topic.Text) {
        results.push({
          title: topic.Text.split(" - ")[0] ?? topic.Text.slice(0, 80),
          snippet: topic.Text,
          url: topic.FirstURL ?? "",
        });
      }
    }
  }

  // Direct results
  if (data.Results) {
    for (const r of data.Results) {
      if (r.Text) {
        results.push({
          title: r.Text.split(" - ")[0] ?? r.Text.slice(0, 80),
          snippet: r.Text,
          url: r.FirstURL ?? "",
        });
      }
    }
  }

  return results;
}
