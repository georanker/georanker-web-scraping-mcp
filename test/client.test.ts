import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/server.js';
import { SEO_TOOL_NAMES } from '../src/seo-contract.js';
import { CLIENT_PROFILE } from '../src/product.js';
import { RemoteService } from '../src/remote.js';
import { AppError } from '../src/errors.js';
const isSeo = String(CLIENT_PROFILE) === 'seo';

test('the fixed product advertises its audience tools, validates hosted schemas and forwards forceLive', async t => {
  const calls: object[] = [];
  const stub = {
    async search(input: object) { calls.push(input); return { kind: 'search', status: 'ready', results: [] }; },
    async fetchPage(input: object) { calls.push(input); return { kind: 'page', status: 'ready', content: 'Fixture page' }; },
    async getSearchResult() { return { kind: isSeo ? 'search' : 'page', status: 'pending', jobId: 'fixture-1' }; },
  };
  const server = createServer(stub, CLIENT_PROFILE);
  const client = new Client({ name: 'client-fixture', version: '1.0.0' });
  const [hostTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(hostTransport), server.connect(serverTransport)]);
  try {
    const catalog = await client.listTools();
    const names = catalog.tools.map(tool => tool.name).sort();
    assert.deepEqual(names, isSeo ? ['get_serp_result', 'search_serps', ...SEO_TOOL_NAMES].sort() : ['fetch_page', 'get_fetch_result']);
    const remote = new RemoteService({}, CLIENT_PROFILE);
    (remote as unknown as { connection: Promise<Client> }).connection = Promise.resolve(client);
    await remote.initialize();
    assert.equal(calls.length, 0, 'Setup checks exact schemas without creating data jobs.');
    const result = await client.callTool({ name: isSeo ? 'search_serps' : 'fetch_page', arguments: { ...(isSeo ? { query: 'fixture' } : { url: 'https://example.com/' }), forceLive: true } });
    assert.notEqual(result.isError, true);
    assert.equal((calls[0] as { forceLive?: boolean }).forceLive, true);
    const tool = catalog.tools.find(item => item.name === (isSeo ? 'search_serps' : 'fetch_page'))!;
    (tool.inputSchema.properties!.forceLive as Record<string, unknown>).default = true;
    t.mock.method(client, 'listTools', async () => catalog);
    await assert.rejects(remote.initialize(), { code: 'REMOTE_SCHEMA_MISMATCH' });
    assert.equal(calls.length, 1, 'Schema drift must not submit a probe query.');
  } finally { await client.close(); await server.close(); }
});

test('remote text-only errors preserve diagnostics and safe recovery without retrying paid work', async () => {
  let calls = 0;
  const client = { async callTool() { calls++; return { isError: true, content: [{ type: 'text', text: 'Original hosted input validation detail.' }] }; } } as unknown as Client;
  const remote = new RemoteService({}, CLIENT_PROFILE);
  (remote as unknown as { connection: Promise<Client> }).connection = Promise.resolve(client);
  const operation = isSeo ? remote.search({ query: 'fixture' }) : remote.fetchPage({ url: 'https://example.com/' });
  await assert.rejects(operation, (error: unknown) => error instanceof AppError && error.code === 'REMOTE_ERROR' && error.message === 'Original hosted input validation detail.' && error.details?.submissionUncertain === true && error.details?.automaticRetryPerformed === false);
  assert.equal(calls, 1);
});

test('operator and direct-API CLI modes are unavailable', () => {
  for (const option of ['--serve', '--issue-token', '--revoke-installation', '--env-file']) {
    const result = spawnSync(process.execPath, ['dist/src/cli.js', option], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported argument/);
    assert.equal(result.stdout, '');
  }
});
