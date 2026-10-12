/** Public WHOIS contract. The price is MCP allowance credits, not provider billing. */
import { domainToASCII } from 'node:url';
import { isIP } from 'node:net';
import { z } from 'zod';
import { AppError } from './errors.js';

export const WHOIS_TOOL = 'get_whois';
export const WHOIS_HEADER = 'X-GeoRanker-WHOIS-Tools';
export const WHOIS_CATALOG = 'whois-v1';
export const WHOIS_MCP_CREDITS = 10;
export interface WhoisInput { domain: string; source?: 'auto' | 'website' | 'whois'; forceLive?: boolean }

export function normalizeWhoisDomain(value: string): string {
  if (/[\s\x00-\x20\x7f\/:?#@%\\*]/u.test(value.trim())) throw new AppError('INVALID_INPUT', 'Use a bare domain name without URL syntax or whitespace.');
  const domain = domainToASCII(value.trim().replace(/\.$/, '')).toLowerCase();
  const labels = domain.split('.');
  if (!domain || domain.length > 253 || isIP(domain) || labels.length < 2 ||
      labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      !/[a-z]/.test(labels.at(-1)!)) {
    throw new AppError('INVALID_INPUT', 'Use a bare public domain name, such as example.com, without a URL, path, port, wildcard or IP address.');
  }
  return domain;
}
export const WHOIS_INPUT_SCHEMA = z.object({
  domain: z.string().trim().min(1).max(253).refine(value => { try { normalizeWhoisDomain(value); return true; } catch { return false; } }, 'Use a bare domain name, such as example.com.')
    .describe('Bare domain name. Internationalized domain names are normalized to ASCII. No URL, path, port or IP address.'),
  source: z.enum(['auto', 'website', 'whois']).default('auto').describe('Provider data source. auto lets GeoRanker select the source for the domain TLD.'),
  forceLive: z.boolean().default(false).describe('Bypass completed MCP cache. A fresh WHOIS costs exactly 10 MCP allowance credits; cache reuse costs zero. Does not override provider caching.'),
}).strict();
export function parseWhoisInput(input: WhoisInput): Required<WhoisInput> {
  const parsed = WHOIS_INPUT_SCHEMA.safeParse(input);
  if (!parsed.success) throw new AppError('INVALID_INPUT', parsed.error.issues.map(issue => issue.message).join(' '), undefined, { submissionUncertain: false });
  return { ...parsed.data, domain: normalizeWhoisDomain(parsed.data.domain) };
}
