import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { AppError } from './errors.js';
import { secureUrl } from './config.js';
import { installationHeaders } from './enrollment.js';
import { deviceFingerprint } from './identity.js';
export { deviceFingerprint } from './identity.js';
import { PRODUCT_PROFILES, SERVER_VERSION, type ProductProfile, type SearchServiceLike, type SearchInput, type SearchResultInput, type FetchPageInput } from './product-contract.js';
import { SEO_REPORT_CATALOG, SEO_REPORT_HEADER, SEO_TOOL_NAMES, type SeoToolName } from './seo-contract.js';
import { createServer } from './server.js';

export const PILOT_MCP_URL = 'https://grmcp.ibl.ro/mcp';
const MAX_ERROR_TEXT = 8192;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const localCatalogs = new Map<ProductProfile, Promise<Map<string, unknown>>>();

function localInputSchemas(service: SearchServiceLike, profile: ProductProfile): Promise<Map<string, unknown>> {
  let catalog = localCatalogs.get(profile);
  if (!catalog) {
    // Use the same SDK serialization as the advertised local tools. This
    // metadata-only exchange cannot invoke a provider or create a data job.
    catalog = (async () => {
      const server = createServer(service, profile);
      const client = new Client({ name: 'local-schema-check', version: SERVER_VERSION });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const listed = await client.listTools();
        return new Map(listed.tools.map(tool => [tool.name, tool.inputSchema]));
      } finally { await client.close(); await server.close(); }
    })().catch(error => { localCatalogs.delete(profile); throw error; });
    localCatalogs.set(profile, catalog);
  }
  return catalog;
}

function canonicalSchema(value: unknown, mode: 'schema' | 'map' | 'data' = 'schema'): unknown {
  if (Array.isArray(value)) return value.map(item => canonicalSchema(item, mode));
  const data = record(value);
  if (!data) return value;
  return Object.fromEntries(Object.keys(data).sort().flatMap(key => {
    if (mode === 'schema' && ['description', 'title', '$schema', '$comment', 'examples'].includes(key)) return [];
    let childMode: 'schema' | 'map' | 'data' = mode === 'map' ? 'schema' : mode;
    if (mode === 'schema') {
      if (['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas', 'dependencies'].includes(key)) childMode = 'map';
      else if (['default', 'const', 'enum', 'required'].includes(key)) childMode = 'data';
    }
    let child = canonicalSchema(data[key], childMode);
    if (mode === 'schema' && ['enum', 'required'].includes(key) && Array.isArray(child)) child = child.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [[key, child]];
  }));
}

function schemaDifferences(expected: unknown, actual: unknown, path = 'inputSchema'): string[] {
  if (JSON.stringify(expected) === JSON.stringify(actual)) return [];
  const left = record(expected), right = record(actual);
  if (!left || !right) return [path];
  return [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    .flatMap(key => schemaDifferences(left[key], right[key], `${path}.${key}`)).slice(0, 12);
}

function recoveryFields(value: unknown): Record<string, unknown> {
  const data = record(value), fields: Record<string, unknown> = {};
  if (typeof data?.reportId === 'string' && /^seo_[a-f0-9-]{36}$/.test(data.reportId)) fields.reportId = data.reportId;
  if (typeof data?.jobId === 'string' && /^[a-zA-Z0-9_-]{1,200}$/.test(data.jobId)) fields.jobId = data.jobId;
  if (typeof data?.submissionUncertain === 'boolean') fields.submissionUncertain = data.submissionUncertain;
  return fields;
}

function textDiagnostic(content: unknown): { text: string; truncated: boolean; value?: Record<string, unknown>; details: Record<string, unknown> } {
  let text = '', truncated = false;
  if (Array.isArray(content)) for (const item of content) {
    const block = record(item);
    if (block?.type !== 'text' || typeof block.text !== 'string' || !block.text.trim()) continue;
    const separator = text ? '\n' : '';
    const remaining = MAX_ERROR_TEXT - text.length - separator.length;
    if (remaining <= 0) { truncated = true; break; }
    text += separator + block.text.slice(0, remaining);
    if (block.text.length > remaining) { truncated = true; break; }
  }
  let value: Record<string, unknown> | undefined;
  if (text && !truncated) {
    try { value = record(JSON.parse(text)); } catch { /* SDK validation errors are ordinary text. */ }
  }
  // Recover only explicitly labelled identifiers. Prose cannot prove that a
  // submission was refused, so never infer submission certainty from text.
  const reportId = text.match(/\breportId["']?\s*[:=]\s*["']?(seo_[a-f0-9-]{36})(?![a-zA-Z0-9_-])/i)?.[1];
  const jobId = text.match(/\bjobId["']?\s*[:=]\s*["']?([a-zA-Z0-9_-]{1,200})(?![a-zA-Z0-9_-])/i)?.[1];
  return { text: text.trim(), truncated, value, details: { ...recoveryFields({ reportId, jobId }), ...(truncated ? { diagnosticTruncated: true } : {}) } };
}

function remoteToolError(result: Record<string, unknown>): AppError {
  const diagnostic = textDiagnostic(result.content);
  const structured = record(result.structuredContent);
  const envelope = structured && (record(structured.error) || typeof structured.message === 'string') ? structured : diagnostic.value;
  const error = record(envelope?.error) ?? envelope;
  const code = typeof error?.code === 'string' && error.code.length > 0 && error.code.length <= 128 ? error.code : 'REMOTE_ERROR';
  const message = typeof error?.message === 'string' && error.message.trim() ? error.message : diagnostic.text || 'The hosted tool failed without a diagnostic.';
  const retry = typeof error?.retryAfterSeconds === 'number' && Number.isFinite(error.retryAfterSeconds) && error.retryAfterSeconds >= 0 ? error.retryAfterSeconds : undefined;
  return new AppError(code, message, retry, { ...diagnostic.details, ...recoveryFields(structured), ...recoveryFields(envelope), ...recoveryFields(error), ...record(error?.details) });
}

function requestError(error: AppError, name: string, input: object, profile: ProductProfile): AppError {
  const arguments_ = record(input);
  const details = { ...recoveryFields({ reportId: arguments_?.reportId, jobId: arguments_?.jobId }), ...error.details };
  details.submissionUncertain = typeof details.submissionUncertain === 'boolean' ? details.submissionUncertain : !name.startsWith('get_');
  details.automaticRetryPerformed = false;
  if (typeof details.nextAction !== 'string' || !details.nextAction.trim()) {
    if (details.reportId) {
      const getter = name === 'update_rank_tracking_schedule' ? 'get_rank_tracking_report' : name.replace(/^create_/, 'get_');
      details.nextAction = `Retain this reportId and use ${getter} to check the existing report before submitting another report or schedule change.`;
    } else if (details.jobId) {
      details.nextAction = `Retain this jobId and use ${PRODUCT_PROFILES[profile].resultTool} to check the existing job before submitting another job.`;
    } else if (details.submissionUncertain) {
      details.nextAction = 'The submission outcome is unknown. Ask the operator to reconcile this request before resubmitting; another create call could duplicate paid work.';
    } else {
      details.nextAction = name.startsWith('get_')
        ? 'Retry this retrieval with the same identifier after resolving the error or waiting for retryAfterSeconds. Do not create a replacement job.'
        : 'No new work was submitted. Resolve the reported error or wait for retryAfterSeconds before explicitly retrying this request.';
    }
  }
  return new AppError(error.code, error.message, error.retryAfterSeconds, details);
}

function queuedRefusal(error: unknown): AppError | undefined {
  // The pinned SDK includes the HTTP error body in this error. Accept only our
  // bounded, explicit pre-dispatch refusal; other failures stay uncertain.
  if (!(error instanceof StreamableHTTPError) || error.code !== 503 || error.message.length > 8192) return;
  const prefix = 'Streamable HTTP error: Error POSTing to endpoint: ';
  if (!error.message.startsWith(prefix)) return;
  try {
    const value = JSON.parse(error.message.slice(prefix.length)).error;
    if (value?.code === 'CAPACITY_LIMIT' && value.details?.submissionUncertain === false && ['queue_full', 'queue_timeout'].includes(value.details.reason)) {
      return new AppError('CAPACITY_LIMIT', 'The hosted MCP request queue is busy. No tool was started. Retry shortly.', 1, { submissionUncertain: false, reason: value.details.reason });
    }
  } catch { /* An unrecognized response cannot prove whether work started. */ }
}
export class RemoteService implements SearchServiceLike {
  private connection?: Promise<Client>;
  private readonly url: URL;
  private headers?: Record<string, string>;
  constructor(private readonly env: NodeJS.ProcessEnv, private readonly profile: ProductProfile = 'combined') {
    this.url = secureUrl(env.GEORANKER_MCP_URL || new URL(PRODUCT_PROFILES[profile].endpoint, PILOT_MCP_URL).href, 'GEORANKER_MCP_URL');
    if (!env.GEORANKER_ACCESS_TOKEN && !env.GEORANKER_INSTALLATION_ID) return;
    if (!env.GEORANKER_ACCESS_TOKEN || !env.GEORANKER_INSTALLATION_ID) throw new AppError('CONFIG_ERROR', 'Set both manual credential fields or neither for automatic registration.');
    const fingerprint = env.GEORANKER_DEVICE_FINGERPRINT || deviceFingerprint();
    if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new AppError('CONFIG_ERROR', 'GEORANKER_DEVICE_FINGERPRINT must be a lowercase SHA-256 hex string.');
    this.headers = { Authorization: `Bearer ${env.GEORANKER_ACCESS_TOKEN}`, 'X-GeoRanker-Installation-Id': env.GEORANKER_INSTALLATION_ID, 'X-GeoRanker-Device-Fingerprint': fingerprint };
  }
  private connect(): Promise<Client> {
    if (!this.connection) {
      const client = new Client({ name: `${PRODUCT_PROFILES[this.profile].name}-bridge`, version: SERVER_VERSION });
      this.connection = (async () => {
        this.headers ??= await installationHeaders(this.url, this.env);
        if (this.profile === 'seo') this.headers[SEO_REPORT_HEADER] = SEO_REPORT_CATALOG;
        // JSON-RPC IDs are unique only inside this transport. The namespace
        // lets a stateless server correlate cancellation without affecting
        // another AI host sharing the same installation credentials.
        const headers = { ...this.headers, 'X-GeoRanker-Request-Group': randomUUID() };
        const transport = new StreamableHTTPClientTransport(this.url, { requestInit: { headers, redirect: 'error' } });
        await client.connect(transport);
        return client;
      })().catch(async error => {
        this.connection = undefined;
        await client.close().catch(() => {});
        if (error instanceof AppError) throw new AppError(error.code, error.message, error.retryAfterSeconds, { ...error.details, submissionUncertain: false });
        const refusal = queuedRefusal(error);
        if (refusal) throw refusal;
        throw new AppError('REMOTE_CONNECTION_FAILED', 'Cannot connect to the hosted MCP. Check its URL, installation credentials, device fingerprint, and availability.', undefined, { submissionUncertain: false });
      });
    }
    return this.connection;
  }
  async initialize(): Promise<void> {
    const listed = await (await this.connect()).listTools();
    const product = PRODUCT_PROFILES[this.profile];
    const required = [product.resultTool, ...('searchTool' in product ? [product.searchTool] : []), ...('fetchTool' in product ? [product.fetchTool] : []), ...(this.profile === 'seo' ? SEO_TOOL_NAMES : [])].sort();
    const available = listed.tools.map(tool => tool.name).sort();
    if (required.length !== available.length || required.some((name, index) => name !== available[index])) {
      throw new AppError('REMOTE_PROFILE_MISMATCH', `The hosted endpoint does not provide the expected tools for ${product.title}. Check GEORANKER_MCP_URL and the server deployment. No query was submitted.`, undefined, { submissionUncertain: false, automaticRetryPerformed: false });
    }
    const local = await localInputSchemas(this, this.profile);
    const differences = listed.tools.flatMap(tool => {
      const paths = schemaDifferences(canonicalSchema(local.get(tool.name)), canonicalSchema(tool.inputSchema));
      return paths.length ? [{ toolName: tool.name, paths }] : [];
    });
    if (differences.length) {
      throw new AppError('REMOTE_SCHEMA_MISMATCH', `The local and hosted input contracts differ for ${differences.map(item => item.toolName).join(', ')}. Update the client and hosted service to compatible versions before submitting work. No query was submitted.`, undefined, {
        submissionUncertain: false, automaticRetryPerformed: false, schemaDifferences: differences,
        nextAction: 'Compare the listed inputSchema fields and update the mismatched client or hosted deployment. Rerun setup before creating any jobs.',
      });
    }
  }
  private async call(name: string, input: object, signal?: AbortSignal): Promise<object> {
    try {
      if (signal?.aborted) throw new AppError('CANCELLED', 'The hosted MCP request was cancelled before submission.', undefined, { submissionUncertain: false });
      const client = await this.connect();
      if (signal?.aborted) throw new AppError('CANCELLED', 'The hosted MCP request was cancelled before submission.', undefined, { submissionUncertain: false });
      const result = await client.callTool({ name, arguments: { ...input } }, undefined, { signal, timeout: 100_000 });
      if (result.isError) throw remoteToolError(result);
      const value = record(result.structuredContent);
      if (!value) {
        const diagnostic = textDiagnostic(result.content);
        throw new AppError('REMOTE_RESPONSE_INVALID', 'The hosted MCP returned an unsupported result. A submitted job may still exist. No automatic tool retry was performed.', undefined, { ...diagnostic.details, ...recoveryFields({ reportId: diagnostic.value?.reportId, jobId: diagnostic.value?.jobId }) });
      }
      return value;
    } catch (error) {
      if (error instanceof AppError) throw requestError(error, name, input, this.profile);
      const refusal = queuedRefusal(error);
      if (refusal) throw requestError(refusal, name, input, this.profile);
      throw requestError(new AppError('REMOTE_REQUEST_FAILED', 'The hosted MCP request did not complete. No automatic tool retry was performed.'), name, input, this.profile);
    }
  }
  search(input: SearchInput, signal?: AbortSignal): Promise<object> {
    const product = PRODUCT_PROFILES[this.profile];
    if (!('searchTool' in product)) return Promise.reject(new AppError('PROFILE_TOOL_UNAVAILABLE', 'SERP search is not available through this MCP profile.'));
    return this.call(product.searchTool, input, signal);
  }
  seoReport(name: SeoToolName, input: Record<string, unknown>, signal?: AbortSignal): Promise<object> {
    if (this.profile !== 'seo' || !SEO_TOOL_NAMES.includes(name)) return Promise.reject(new AppError('PROFILE_TOOL_UNAVAILABLE', 'SEO reports require the SEO MCP profile.'));
    return this.call(name, input, signal);
  }
  fetchPage(input: FetchPageInput, signal?: AbortSignal): Promise<object> {
    const product = PRODUCT_PROFILES[this.profile];
    if (!('fetchTool' in product)) return Promise.reject(new AppError('PROFILE_TOOL_UNAVAILABLE', 'Page fetching is not available through this MCP profile.'));
    return this.call(product.fetchTool, input, signal);
  }
  getSearchResult(input: SearchResultInput, signal?: AbortSignal): Promise<object> {
    const { expectedKind: _expectedKind, ...arguments_ } = input;
    return this.call(PRODUCT_PROFILES[this.profile].resultTool, arguments_, signal);
  }
  async close(): Promise<void> { if (this.connection) await (await this.connection).close(); }
}
