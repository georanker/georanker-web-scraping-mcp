import { AppError } from './errors.js';

export const RESULTS_PER_PAGE = 10;
export const MAX_SEARCH_PAGES = 10;
export const MAX_SEARCH_RESULTS = RESULTS_PER_PAGE * MAX_SEARCH_PAGES;

// Pages express organic-result depth from the first result, not a page offset.
export function resolveSearchDepth(input: { pages?: number; limit?: number }): { maxResults: number; limit: number } {
  if (input.pages !== undefined && (!Number.isInteger(input.pages) || input.pages < 1 || input.pages > MAX_SEARCH_PAGES)) {
    throw new AppError('INVALID_INPUT', `pages must be an integer between 1 and ${MAX_SEARCH_PAGES}.`);
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > MAX_SEARCH_RESULTS)) {
    throw new AppError('INVALID_INPUT', `limit must be an integer between 1 and ${MAX_SEARCH_RESULTS}.`);
  }
  const pages = input.pages ?? Math.ceil((input.limit ?? RESULTS_PER_PAGE) / RESULTS_PER_PAGE);
  const maxResults = pages * RESULTS_PER_PAGE;
  const limit = input.limit ?? maxResults;
  if (limit > maxResults) throw new AppError('INVALID_INPUT', 'limit cannot exceed pages × 10. Increase pages or omit it to infer the depth from limit.');
  return { maxResults, limit };
}
