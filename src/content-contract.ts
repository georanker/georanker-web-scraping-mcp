/** Optional content capabilities. No provider or storage configuration. */
export const CONTENT_HEADER = 'X-GeoRanker-Content-Tools';
export const CONTENT_CATALOG = 'content-v1';
export const DEFAULT_CHUNK_BYTES = 50_000;
export const MAX_CHUNK_BYTES = 100_000;
export interface ContentOptions {
  fullContent?: boolean;
  cursor?: string;
  maxBytes?: number;
  download?: boolean;
}
export type ResourceType = 'page' | 'css' | 'javascript';
