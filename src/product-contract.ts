/** Public MCP product identities and input contracts. No provider configuration belongs here. */
import type { SeoToolName } from './seo-contract.js';
import type { WhoisInput } from './whois-contract.js';
import type { ContentOptions, ResourceType } from './content-contract.js';
export const SERVER_VERSION = '0.17.0';

export type ProductProfile = 'combined' | 'seo' | 'scraping';
export type JobKind = 'search' | 'page';

export const PRODUCT_PROFILES = {
  combined: {
    name: 'georanker-search-mcp',
    title: 'GeoRanker Search MCP',
    endpoint: '/mcp',
    searchTool: 'search',
    fetchTool: 'fetch_page',
    resultTool: 'get_search_result',
  },
  seo: {
    name: 'georanker-seo-mcp',
    title: 'SEO & SERP MCP by GeoRanker',
    endpoint: '/seo/mcp',
    searchTool: 'search_serps',
    resultTool: 'get_serp_result',
  },
  scraping: {
    name: 'georanker-web-scraping-mcp',
    title: 'Web Scraping MCP by GeoRanker',
    endpoint: '/scraping/mcp',
    fetchTool: 'fetch_page',
    resultTool: 'get_fetch_result',
  },
} as const;

export function profileForEndpoint(path: string): ProductProfile | undefined {
  return (Object.keys(PRODUCT_PROFILES) as ProductProfile[])
    .find(profile => PRODUCT_PROFILES[profile].endpoint === path);
}

export interface SearchInput {
  query: string;
  limit?: number;
  pages?: number;
  region?: string;
  searchEngine?: 'google' | 'bing' | 'yahoo';
  language?: string;
  waitMs?: number;
  forceLive?: boolean;
}

export interface SearchResultInput extends ContentOptions {
  jobId: string;
  waitMs?: number;
  limit?: number;
  format?: 'text' | 'html';
  /** Internal constraint set by the server profile, never a caller-controlled tool argument. */
  expectedKind?: JobKind;
}

export interface FetchPageInput extends ContentOptions {
  url: string;
  resourceType?: ResourceType;
  format?: 'text' | 'html';
  waitMs?: number;
  forceLive?: boolean;
}

export interface SearchServiceLike {
  getDownload?(input: { jobId: string; format?: 'text' | 'html' }, signal?: AbortSignal): Promise<{ path: string; bytes: number; sha256: string; contentType: string; filename: string }>;
  getBalance?(signal?: AbortSignal): Promise<object>;
  getWhois?(input: WhoisInput, signal?: AbortSignal): Promise<object>;
  seoReport?(name: SeoToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<object>;
  search(input: SearchInput, signal?: AbortSignal): Promise<object>;
  fetchPage(input: FetchPageInput, signal?: AbortSignal): Promise<object>;
  getSearchResult(input: SearchResultInput, signal?: AbortSignal): Promise<object>;
}
