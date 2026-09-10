/** Public report contracts only. Provider credentials and storage stay in the private service. */
import { z } from 'zod';
import { AppError } from './errors.js';

export const SEO_REPORT_HEADER = 'X-GeoRanker-SEO-Tools';
export const SEO_REPORT_CATALOG = 'reports-v1';
export const SEO_REPORT_KINDS = ['rank_tracking', 'onpage', 'broken_links', 'backlinks', 'keyword_volume'] as const;
export type SeoReportKind = typeof SEO_REPORT_KINDS[number];
const text = z.string().trim().min(1).max(500);
const publicUrl = z.string().trim().max(2048).url().regex(/^https?:\/\//i);
const forceLive = z.boolean().default(false).describe('Bypass completed-result reuse (seven days by default). Retain unresolved work instead of creating a duplicate report.');
const reportId = z.string().regex(/^seo_[a-f0-9-]{36}$/).describe('The MCP reportId returned by the matching create tool, not a provider report ID.');
const scheduleDays = z.number().int().min(1).max(365).optional();
const lookup = z.object({ reportId }).strict();

export const SEO_INPUT_SCHEMAS = {
  create_rank_tracking_report: z.object({
    reportName: text.default('MCP rank tracking'),
    targetDomain: text.describe('Public domain whose ranking is tracked.'),
    keywords: z.array(text).min(1).max(200),
    locations: z.array(z.string().trim().min(1).max(200)).min(1).max(50).describe('Location names, for example Bucharest, Romania. Every keyword is checked in every location and engine.'),
    engines: z.array(z.string().trim().min(1).max(50)).min(1).max(10).default(['google']),
    device: z.enum(['desktop', 'mobile']).default('desktop'),
    trackTop: z.number().int().min(1).max(100).default(10),
    isRecurring: z.boolean().default(false).describe('Enable provider-managed recurring work only when explicitly requested. Future runs can consume credits.'),
    scheduleDays,
    fetchKeywordData: z.boolean().default(false),
    forceLive,
  }).strict().refine(value => !value.isRecurring || value.scheduleDays !== undefined, { message: 'Set scheduleDays explicitly when enabling recurring tracking.', path: ['scheduleDays'] }),
  get_rank_tracking_report: lookup,
  update_rank_tracking_schedule: z.object({ reportId, isRecurring: z.boolean(), scheduleDays }).strict()
    .refine(value => !value.isRecurring || value.scheduleDays !== undefined, { message: 'Set scheduleDays explicitly when enabling recurring tracking.', path: ['scheduleDays'] }),
  create_onpage_report: z.object({
    url: publicUrl,
    devices: z.array(z.enum(['mobile', 'desktop'])).min(1).max(2).default(['mobile', 'desktop']),
    isRecurring: z.literal(false).default(false),
    forceLive,
  }).strict(),
  get_onpage_report: lookup,
  create_broken_links_report: z.object({
    url: publicUrl,
    scope: z.enum(['site', 'page', 'domain']).default('site').describe('Use site for a bounded site crawl or page for analysis of links on the supplied page. The legacy domain value is a deprecated alias for site. Path-restricted crawling is unsupported; do not substitute a different coverage without the user choosing it.'),
    maxDepth: z.number().int().min(1).max(10).default(2).describe('Maximum crawl depth; MCP limit 10.'),
    maxPages: z.number().int().min(1).max(1000).default(20).describe('Maximum pages to crawl; MCP limit 1000. Each block of up to 100 requested pages counts as one shared admission unit (rounded up). Keep the user-requested crawl coverage.'),
    checkExternalLinks: z.literal(false).default(false).describe('Return internal link and resource checks only. Output states the hostname boundary, excluded rows and actual crawl coverage.'),
    forceLive,
  }).strict(),
  get_broken_links_report: lookup,
  create_backlinks_report: z.object({
    target: z.string().trim().min(1).max(2048).describe('Public domain or URL to analyze.'),
    endpoint: z.enum(['summary', 'backlinks', 'referring_domains', 'anchors', 'history', 'timeseries_new_lost', 'competitors', 'domain_pages']).default('summary'),
    name: text.optional(),
    forceLive,
  }).strict(),
  get_backlinks_report: lookup,
  create_keyword_volume_report: z.object({
    name: text.default('MCP keyword volumes'),
    keywords: z.array(text).min(1).max(200).describe('Keywords for the volume report; MCP limit 200.'),
    location: z.string().trim().min(1).max(200).optional(),
    provider: z.string().trim().min(1).max(100).optional().describe('Documented SEO API provider identifier. Omit to use the operator-configured volume provider.'),
    endpoint: z.string().trim().min(1).max(100).optional().describe('Documented volume endpoint identifier. Omit to use the operator-configured volume endpoint.'),
    forceLive,
  }).strict(),
  get_keyword_volume_report: lookup,
} as const;
export type SeoToolName = keyof typeof SEO_INPUT_SCHEMAS;
export const SEO_TOOL_NAMES = Object.keys(SEO_INPUT_SCHEMAS) as SeoToolName[];

export function parseSeoInput(name: SeoToolName, input: unknown): Record<string, unknown> {
  if (name === 'create_broken_links_report' && input && typeof input === 'object' && 'scope' in input && input.scope === 'path') {
    throw new AppError('INVALID_INPUT', 'Broken-link scope "path" is unsupported. Choose "site" for a bounded site crawl or "page" to analyze links on the supplied page. Ask the user to choose the intended coverage; do not silently replace a path restriction.', undefined, { field: 'scope', allowedValues: ['site', 'page'], submissionUncertain: false });
  }
  const result = SEO_INPUT_SCHEMAS[name]?.safeParse(input);
  if (!result?.success) throw new AppError('INVALID_INPUT', 'Report arguments do not match the tool schema. Check required fields, report ID, batch limits and schedule.');
  if (name === 'create_broken_links_report' && 'scope' in result.data && result.data.scope === 'domain') return { ...result.data, scope: 'site' };
  return result.data;
}

export function seoAdmissionUnits(name: SeoToolName, raw: unknown): number {
  const input = parseSeoInput(name, raw);
  if (name === 'create_rank_tracking_report') return (input.keywords as string[]).length * (input.locations as string[]).length * (input.engines as string[]).length;
  if (name === 'create_broken_links_report') return Math.ceil((input.maxPages as number) / 100);
  if (name === 'create_keyword_volume_report') return (input.keywords as string[]).length;
  if (name === 'create_onpage_report') return (input.devices as string[]).length;
  return 1;
}

export const SEO_TOOL_DESCRIPTIONS: Record<SeoToolName, { title: string; description: string }> = {
  create_rank_tracking_report: { title: 'Track rankings across keywords and locations', description: 'Create a domain rank report for multiple keywords, locations and engines. Requested checks are keywords × locations × engines and consume the shared allowance. Optional recurring tracking must be explicitly requested and enabled by the operator; future provider runs can consume credits. Use get_rank_tracking_report for the returned reportId.' },
  get_rank_tracking_report: { title: 'Get rank tracking report', description: 'Retrieve an owned rank tracking report and its keyword results, without creating another report. Preserve checked coverage and provider timestamps; do not infer absent rankings.' },
  update_rank_tracking_schedule: { title: 'Update rank tracking schedule', description: 'Enable, change or stop provider-managed recurring tracking for an owned report. Enabling requires an explicit interval and can cause future credit-consuming runs. This changes persistent report settings; use only when requested.' },
  create_onpage_report: { title: 'Run Lighthouse on-page SEO analysis', description: 'Create a Lighthouse/PSI report for one public URL on mobile, desktop or both. This audits the specified page; it is not a site-wide crawl. Use get_onpage_report for the returned reportId.' },
  get_onpage_report: { title: 'Get Lighthouse SEO report', description: 'Retrieve an owned Lighthouse/PSI summary with category scores, audit findings, explanations, metrics and completion status for each requested device. Missing devices are named explicitly. Embedded screenshots and detailed audit/resource tables are omitted and labeled. Does not run a new audit.' },
  create_broken_links_report: { title: 'Analyze broken internal links', description: 'Analyze internal links with a bounded site crawl (scope site, the default) or links on the supplied page (scope page). The old domain scope is accepted as an alias for site; path-restricted crawling is unsupported. External-link checking is disabled. Each block of up to 100 requested pages uses one shared admission unit. Keep the user-requested coverage; do not silently shrink it to fit an allowance or change a path restriction to another scope. Use get_broken_links_report for the returned reportId.' },
  get_broken_links_report: { title: 'Get broken internal links report', description: 'Retrieve internal link and resource checks without re-running the crawl. Coverage separates returned internal rows from provider totals and excluded external rows. A completed bounded crawl does not establish full-site navigation coverage; HTTP 403 means access denied, not necessarily a missing page.' },
  create_backlinks_report: { title: 'Create backlink intelligence report', description: 'Request backlink summary, backlinks, referring domains, anchors, history, new/lost timeseries, competitors or domain pages for a public target. New reports can consume provider credits. Use get_backlinks_report for the returned reportId.' },
  get_backlinks_report: { title: 'Get backlink report', description: 'Retrieve an owned backlink report and provider results without creating another report. Preserve report type, timestamps and actual coverage. Ready means the requested response is available; coverage states returned rows versus provider totals. These tools do not export additional provider pages.' },
  create_keyword_volume_report: { title: 'Research keyword search volumes', description: 'Create a keyword report using the configured volume provider and endpoint, or explicitly supplied documented identifiers. Supports multiple keywords and an optional location. New work can consume credits. Use get_keyword_volume_report for the returned reportId.' },
  get_keyword_volume_report: { title: 'Get keyword volume report', description: 'Retrieve an owned keyword report and its provider data without creating another report. Only describe volume, date, units and location actually returned by the provider.' },
};
