import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError, type ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import { createSupervisor, createWorker } from '../src/supervisor.js';
import { updateDirectory, type UpdateOptions, type UpdateResult } from '../src/updater.js';

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const ROOT_A = '/fixture/installed';
const ROOT_B = '/fixture/prepared';
const tool = { name: 'fixture', description: 'Synthetic local worker.', inputSchema: { type: 'object' as const } };

function deferred() {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

interface WorkerBehavior {
  capabilities?: ServerCapabilities;
  failCreate?: boolean;
  warmup?: ReturnType<typeof deferred>;
}
interface WorkerRecord {
  root: string;
  invocations: string[];
  closed: boolean;
  entered: ReturnType<typeof deferred>;
  complete: ReturnType<typeof deferred>;
  canceled: ReturnType<typeof deferred>;
  disconnect(): Promise<void>;
}

async function fixture(t: TestContext, behaviors: Record<string, WorkerBehavior> = {}) {
  const records: WorkerRecord[] = [];
  const logs: string[] = [];
  const state = await mkdtemp(join(tmpdir(), 'georanker-supervisor-state-'));
  t.after(() => rm(state, { recursive: true, force: true }));
  let now = 1_000;
  let selected: { root: string; commit?: string } = { root: ROOT_A, commit: COMMIT_A };
  let next: UpdateResult = { status: 'current', commit: COMMIT_A };
  let checkFailure = false;
  let checks = 0;
  const checkArguments: unknown[][] = [];
  let checkWait: Promise<void> | undefined;
  const options: UpdateOptions = {
    repository: 'georanker/georanker-seo-mcp', version: '0.13.0', bundledRoot: ROOT_A,
    env: { GEORANKER_MCP_UPDATE_DIR: state }, log: message => { logs.push(message); },
  };
  const supervisor = await createSupervisor(options, {
    automaticChecks: false,
    now: () => now,
    idleMs: 60_000,
    select: async () => selected,
    check: async (...args: unknown[]) => {
      checks++;
      checkArguments.push(args);
      if (checkWait) await checkWait;
      if (checkFailure) throw new Error('Fixture release feed unavailable.');
      return next;
    },
    createWorker: async root => {
      const behavior = behaviors[root] || {};
      if (behavior.failCreate) throw new Error('Fixture worker cannot initialize.');
      if (behavior.warmup) await behavior.warmup.promise;
      const record: WorkerRecord = {
        root, invocations: [], closed: false,
        entered: deferred(), complete: deferred(), canceled: deferred(), disconnect: async () => {},
      };
      records.push(record);
      const server = new Server(
        { name: 'fixture-worker', version: root === ROOT_A ? '0.13.0' : '0.13.1' },
        { capabilities: behavior.capabilities ?? { tools: { listChanged: true } } },
      );
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [tool] }));
      server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const action = String(request.params.arguments?.action || 'immediate');
        record.invocations.push(action);
        const diagnostic = { error: { code: String(request.params.arguments?.code || 'REMOTE_SCHEMA_MISMATCH'), message: 'Fixture compatibility failure.' } };
        if (action === 'error') return { content: [{ type: 'text' as const, text: JSON.stringify(diagnostic) }], structuredContent: diagnostic, isError: true };
        if (action === 'text-error') return { content: [{ type: 'text' as const, text: JSON.stringify(diagnostic) }], isError: true };
        if (action === 'rpc-error') throw new McpError(ErrorCode.InvalidRequest, diagnostic.error.message, diagnostic.error);
        if (action === 'untrusted-text') return { content: [{ type: 'text' as const, text: JSON.stringify(diagnostic) }], structuredContent: { root, action } };
        if (action === 'hold') {
          extra.signal.addEventListener('abort', () => { record.canceled.resolve(); }, { once: true });
          record.entered.resolve();
          await record.complete.promise;
        }
        return { content: [{ type: 'text' as const, text: root }], structuredContent: { root, action } };
      });
      const client = new Client({ name: 'fixture-supervisor', version: '1.0.0' });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      await client.connect(clientTransport);
      record.disconnect = async () => {
        if (record.closed) return;
        record.closed = true;
        record.complete.resolve();
        await client.close();
        await server.close();
      };
      return { root, client, close: record.disconnect };
    },
  });
  const host = new Client({ name: 'fixture-host', version: '1.0.0' });
  const [hostTransport, supervisorTransport] = InMemoryTransport.createLinkedPair();
  let hostClosed = 0;
  host.onclose = () => { hostClosed++; };
  await supervisor.connect(supervisorTransport);
  await host.connect(hostTransport);
  t.after(async () => { await supervisor.close(); await host.close(); });
  return {
    supervisor, host, logs, records, options, checkArguments,
    waitForCheck(value?: Promise<void>) { checkWait = value; },
    get checks() { return checks; },
    get hostClosed() { return hostClosed; },
    advance(ms = 60_001) { now += ms; },
    prepare(root = ROOT_B) {
      selected = { root, commit: COMMIT_B };
      next = { status: 'prepared', commit: COMMIT_B, version: '0.13.1' };
    },
    unavailable() { checkFailure = true; },
    current() { next = { status: 'current', commit: selected.commit }; },
  };
}

function resultRoot(value: unknown): string | undefined {
  return (value as { structuredContent?: { root?: string } }).structuredContent?.root;
}

test('idle updates replace the worker while the initialized host connection stays open', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_A);
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_B);
  assert.equal(f.hostClosed, 0);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_B);
  assert.deepEqual((await f.host.listTools()).tools.map(item => item.name), ['fixture']);
  assert.equal(f.records.length, 2);
  assert.equal(f.records[0]!.closed, true);
  assert.equal(f.records[1]!.closed, false);
  assert.equal(f.logs.length, 1, 'Only the applied update should produce a log.');
  f.current();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.records.length, 2, 'The same prepared root must never restart twice.');
  assert.equal(f.logs.length, 1);
});

test('an active tool call finishes on its original worker exactly once before the update applies', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const old = f.records[0]!;
  const pending = f.host.callTool({ name: 'fixture', arguments: { action: 'hold' } });
  await old.entered.promise;
  assert.equal(f.supervisor.activeRequests, 1);
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(old.closed, false);
  assert.deepEqual(old.invocations, ['hold']);
  old.complete.resolve();
  assert.equal(resultRoot(await pending), ROOT_A);
  assert.equal(f.supervisor.activeRequests, 0);
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_A, 'The idle interval starts after the request completes.');
  f.advance();
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_B);
  assert.deepEqual(old.invocations, ['hold'], 'A completed call must never be replayed on the replacement.');
  assert.deepEqual(f.records[1]!.invocations, []);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_B);
  assert.equal(f.hostClosed, 0);
});

test('new work arriving during candidate warmup prevents the active worker from being replaced', { timeout: 5_000 }, async t => {
  const warmup = deferred();
  const f = await fixture(t, { [ROOT_B]: { warmup } });
  f.prepare();
  f.advance();
  const checking = f.supervisor.checkNow();
  // Let the async release selection and worker factory enter their warmup wait.
  await new Promise<void>(resolve => setImmediate(resolve));
  const old = f.records[0]!;
  const pending = f.host.callTool({ name: 'fixture', arguments: { action: 'hold' } });
  await old.entered.promise;
  warmup.resolve();
  await checking;
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(old.closed, false);
  assert.equal(f.logs.length, 0);
  old.complete.resolve();
  assert.equal(resultRoot(await pending), ROOT_A);
  f.advance();
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_B);
  assert.deepEqual(old.invocations, ['hold']);
  assert.equal(f.hostClosed, 0);
});

test('failed candidate startup leaves the previous worker and host connection usable', { timeout: 5_000 }, async t => {
  const f = await fixture(t, { [ROOT_B]: { failCreate: true } });
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(f.records[0]!.closed, false);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_A);
  assert.equal(f.hostClosed, 0);
  assert.ok(!f.logs.some(message => /applied|updated to/i.test(message)));
});

test('a candidate with different negotiated capabilities cannot replace the running worker', { timeout: 5_000 }, async t => {
  const f = await fixture(t, { [ROOT_B]: { capabilities: { tools: { listChanged: true }, resources: {} } } });
  const directory = await persistPreparedPointer(f.options);
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(f.records[0]!.closed, false);
  assert.equal(f.records[1]!.closed, true, 'Incompatible candidates must not leave child connections running.');
  await assertPreparedPointerRetained(directory);
  f.current();
  f.advance();
  await f.supervisor.checkNow();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.records.length, 2, 'This host session must not repeatedly warm a release that needs capability renegotiation.');
  await assertPreparedPointerRetained(directory);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_A);
  assert.equal(f.hostClosed, 0);
});

test('cancellation is forwarded but does not establish that remote work completed or permit a swap', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const old = f.records[0]!;
  const controller = new AbortController();
  const pending = f.host.callTool({ name: 'fixture', arguments: { action: 'hold' } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await old.entered.promise;
  controller.abort(new Error('Fixture request canceled.'));
  await rejected;
  await old.canceled.promise;
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(old.closed, false);
  old.complete.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  f.advance();
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_A, 'Canceled requests have ambiguous completion, so this session keeps its worker.');
  assert.deepEqual(old.invocations, ['hold']);
  assert.equal(f.hostClosed, 0);
  assert.equal(f.logs.length, 0);
});

test('unchanged and unavailable checks are silent and leave the active worker alone', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  f.advance();
  await f.supervisor.checkNow();
  await f.supervisor.checkNow();
  f.unavailable();
  await f.supervisor.checkNow();
  assert.equal(f.checks, 3);
  assert.deepEqual(f.logs, []);
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0]!.closed, false);
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(f.hostClosed, 0);
});

test('closing the supervisor closes its live worker and host connection', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_B);
  await f.supervisor.close();
  assert.ok(f.records.every(record => record.closed));
  assert.equal(f.hostClosed, 1);
  await f.supervisor.close();
  assert.equal(f.hostClosed, 1, 'Repeated shutdown must be harmless.');
});

test('the default worker factory initializes real stdio and terminates its child on close', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'georanker-supervisor-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const script = [
    "import { createInterface } from 'node:readline';",
    "const input = createInterface({ input: process.stdin });",
    "input.on('line', line => {",
    "  const request = JSON.parse(line);",
    "  if (!Object.hasOwn(request, 'id')) return;",
    "  let result = {};",
    "  if (request.method === 'initialize') result = {protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture-process',version:'0.13.0'}};",
    "  if (request.method === 'tools/list') result = {tools:[]};",
    "  if (request.method === 'tools/call') result = {content:[{type:'text',text:String(process.pid)}],structuredContent:{pid:process.pid}};",
    "  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');",
    "});",
    "input.on('close', () => process.exit(0));",
  ].join('\n');
  await writeFile(join(root, 'dist/src/worker.js'), script);
  const worker = await createWorker(root, { PATH: process.env.PATH, GEORANKER_MCP_AUTO_UPDATE: '0' });
  t.after(() => worker.close());
  assert.equal(worker.root, root);
  assert.equal(worker.client.getServerVersion()?.name, 'fixture-process');
  const value = await worker.client.callTool({ name: 'fixture' });
  const pid = (value.structuredContent as { pid: number }).pid;
  assert.ok(Number.isSafeInteger(pid) && pid > 0 && pid !== process.pid);
  await worker.close();
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ESRCH');
});

async function persistPreparedPointer(options: UpdateOptions): Promise<string> {
  const directory = updateDirectory(options);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'current.json'), JSON.stringify({ current: COMMIT_B, previous: COMMIT_A }));
  return directory;
}
async function assertPreparedPointerRetained(directory: string): Promise<void> {
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')), { current: COMMIT_B, previous: COMMIT_A });
  await assert.rejects(readFile(join(directory, 'rejected.json')), (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT');
}

test('shutdown during candidate warmup leaves the prepared release available for the next launch', { timeout: 5_000 }, async t => {
  const warmup = deferred();
  const f = await fixture(t, { [ROOT_B]: { warmup } });
  const directory = await persistPreparedPointer(f.options);
  f.prepare();
  f.advance();
  const checking = f.supervisor.checkNow();
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.supervisor.close();
  warmup.reject(new Error('Fixture worker preparation aborted by shutdown.'));
  await checking;
  await assertPreparedPointerRetained(directory);
  assert.ok(f.records.every(record => record.closed));
  assert.equal(f.hostClosed, 1);
  assert.deepEqual(f.logs, []);
});

test('a confirmed dead worker recovers after cancellation without waiting for idle or replaying the call', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const old = f.records[0]!;
  const controller = new AbortController();
  const pending = f.host.callTool({ name: 'fixture', arguments: { action: 'hold' } }, undefined, { signal: controller.signal });
  const rejected = assert.rejects(pending, /cancel|abort/i);
  await old.entered.promise;
  controller.abort(new Error('Fixture request canceled.'));
  await rejected;
  await old.canceled.promise;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.supervisor.activeRequests, 0);
  await old.disconnect();
  await f.supervisor.applyIfIdle();
  assert.equal(f.records.length, 2, 'A dead worker can be replaced immediately even after ambiguous cancellation.');
  assert.equal(f.records[0]!.closed, true);
  assert.equal(f.records[1]!.closed, false);
  assert.deepEqual(old.invocations, ['hold']);
  assert.deepEqual(f.records[1]!.invocations, []);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_A);
  assert.equal(f.hostClosed, 0);
  assert.deepEqual(f.logs, [], 'Worker recovery is not an update check or an applied release.');
});

test('a logging callback failure cannot roll back an update that already became active', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const directory = await persistPreparedPointer(f.options);
  let attempts = 0;
  f.options.log = () => { attempts++; throw new Error('Fixture stderr write failed.'); };
  f.prepare();
  f.advance();
  await f.supervisor.checkNow();
  assert.equal(f.supervisor.workerRoot, ROOT_B);
  assert.equal(f.records[0]!.closed, true);
  assert.equal(f.records[1]!.closed, false);
  assert.equal(attempts, 1);
  await assertPreparedPointerRetained(directory);
  assert.equal(resultRoot(await f.host.callTool({ name: 'fixture' })), ROOT_B);
  assert.equal(f.hostClosed, 0);
});

test('forwarding outlives the remote request budget and a forwarding timeout pins the live worker', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const old = f.records[0]!;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let settled = false;
    const pending = f.host.callTool({ name: 'fixture', arguments: { action: 'hold' } }, undefined, { timeout: 200_000 });
    const observed = pending.then(
      value => { settled = true; return { value, error: undefined }; },
      (error: unknown) => { settled = true; return { value: undefined, error }; },
    );
    await old.entered.promise;
    t.mock.timers.tick(100_001);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(settled, false, 'The supervisor must not impose the SDK default 60-second timeout on the remote 100-second budget.');
    t.mock.timers.tick(10_000);
    const outcome = await observed;
    assert.ok(outcome.error instanceof Error);
    assert.equal((outcome.error as { code?: number }).code, ErrorCode.RequestTimeout);
    assert.equal(f.supervisor.activeRequests, 0);
    await old.canceled.promise;
    f.prepare();
    f.advance();
    await f.supervisor.checkNow();
    assert.equal(f.supervisor.workerRoot, ROOT_A, 'Timeout does not establish that underlying work completed.');
    assert.equal(old.closed, false);
    assert.deepEqual(old.invocations, ['hold']);
    assert.equal(f.records.length, 1);
    assert.deepEqual(f.logs, []);
    old.complete.resolve();
  } finally {
    t.mock.timers.reset();
  }
});

test('compatibility errors trigger a forced check immediately after an ordinary check without replaying work', { timeout: 5_000 }, async t => {
  for (const code of ['REMOTE_SCHEMA_MISMATCH', 'REMOTE_PROFILE_MISMATCH', 'REMOTE_VERSION_MISMATCH', 'CLIENT_VERSION_MISMATCH']) {
    const f = await fixture(t);
    await f.supervisor.checkNow();
    f.advance(1);
    const result = await f.host.callTool({ name: 'fixture', arguments: { action: 'error', code } });
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(result.isError, true);
    assert.equal((result.structuredContent as { error: { code: string } }).error.code, code);
    assert.deepEqual(f.checkArguments, [[false], [true]], code + ' must bypass the ordinary five-minute cooldown.');
    assert.deepEqual(f.records[0]!.invocations, ['error'], 'The compatibility failure must reach the host without retrying its tool.');
    assert.equal(f.records.length, 1);
    assert.equal(f.hostClosed, 0);
    assert.deepEqual(f.logs, []);
  }
});

test('text-only and thrown compatibility diagnostics also trigger one forced check', { timeout: 5_000 }, async t => {
  for (const action of ['text-error', 'rpc-error']) {
    const f = await fixture(t);
    const request = f.host.callTool({ name: 'fixture', arguments: { action, code: 'REMOTE_SCHEMA_MISMATCH' } });
    if (action === 'rpc-error') await assert.rejects(request, /Fixture compatibility failure/);
    else assert.equal((await request).isError, true);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.deepEqual(f.checkArguments, [[true]], action);
    assert.deepEqual(f.records[0]!.invocations, [action]);
    assert.deepEqual(f.logs, []);
  }
});

test('ordinary errors and successful source text containing compatibility codes never force an update check', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  assert.equal((await f.host.callTool({ name: 'fixture', arguments: { action: 'error', code: 'RATE_LIMIT' } })).isError, true);
  assert.equal((await f.host.callTool({ name: 'fixture', arguments: { action: 'text-error', code: 'INVALID_ARGUMENTS' } })).isError, true);
  await assert.rejects(f.host.callTool({ name: 'fixture', arguments: { action: 'rpc-error', code: 'PROVIDER_ERROR' } }), /Fixture compatibility failure/);
  const source = await f.host.callTool({ name: 'fixture', arguments: { action: 'untrusted-text', code: 'REMOTE_SCHEMA_MISMATCH' } });
  assert.notEqual(source.isError, true);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.checkArguments, []);
  assert.deepEqual(f.records[0]!.invocations, ['error', 'text-error', 'rpc-error', 'untrusted-text']);
  assert.equal(f.records.length, 1);
  assert.deepEqual(f.logs, []);
});

test('concurrent and repeated compatibility errors coalesce without delaying responses or disabling ordinary checks', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const checkGate = deferred();
  f.waitForCheck(checkGate.promise);
  const results = await Promise.all(Array.from({ length: 5 }, () =>
    f.host.callTool({ name: 'fixture', arguments: { action: 'error', code: 'REMOTE_SCHEMA_MISMATCH' } })));
  assert.ok(results.every(result => result.isError === true), 'Tool errors must return while the release check remains pending.');
  assert.deepEqual(f.checkArguments, [[true]]);
  assert.equal(f.records[0]!.invocations.length, 5, 'Each submitted tool is executed exactly once.');
  f.waitForCheck();
  checkGate.resolve();
  await new Promise<void>(resolve => setImmediate(resolve));
  await f.host.callTool({ name: 'fixture', arguments: { action: 'error', code: 'REMOTE_VERSION_MISMATCH' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.deepEqual(f.checkArguments, [[true]], 'One worker release gets one urgent check per host session.');
  f.advance(300_001);
  await f.supervisor.checkNow();
  assert.deepEqual(f.checkArguments, [[true], [false]], 'Routine checks continue after the immediate compatibility check.');
  assert.equal(f.records[0]!.invocations.length, 6);
  assert.deepEqual(f.logs, []);
});

test('an urgent compatibility check prepares an update while preserving unrelated active work and the failed call', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  const old = f.records[0]!;
  const active = f.host.callTool({ name: 'fixture', arguments: { action: 'hold' } });
  await old.entered.promise;
  f.prepare();
  const failure = await f.host.callTool({ name: 'fixture', arguments: { action: 'error', code: 'REMOTE_SCHEMA_MISMATCH' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(failure.isError, true);
  assert.deepEqual(f.checkArguments, [[true]]);
  assert.equal(f.supervisor.activeRequests, 1);
  f.advance();
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(old.closed, false);
  assert.deepEqual(old.invocations, ['hold', 'error']);
  assert.equal(f.records.length, 1);
  old.complete.resolve();
  assert.equal(resultRoot(await active), ROOT_A);
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_A, 'Handover still waits for the idle period after active work finishes.');
  f.advance();
  await f.supervisor.applyIfIdle();
  assert.equal(f.supervisor.workerRoot, ROOT_B);
  assert.deepEqual(old.invocations, ['hold', 'error']);
  assert.deepEqual(f.records[1]!.invocations, [], 'A prepared release must not replay either request.');
  assert.equal(f.hostClosed, 0);
  assert.equal(f.logs.length, 1);
});

test('an unavailable urgent compatibility check stays silent and preserves the original diagnostic', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  f.unavailable();
  const result = await f.host.callTool({ name: 'fixture', arguments: { action: 'error', code: 'REMOTE_SCHEMA_MISMATCH' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result.isError, true);
  assert.equal((result.structuredContent as { error: { code: string } }).error.code, 'REMOTE_SCHEMA_MISMATCH');
  assert.deepEqual(f.checkArguments, [[true]]);
  assert.deepEqual(f.logs, []);
  assert.equal(f.supervisor.workerRoot, ROOT_A);
  assert.equal(f.hostClosed, 0);
});

test('an explicit auto-update opt-out suppresses urgent compatibility checks too', { timeout: 5_000 }, async t => {
  const f = await fixture(t);
  f.options.env.GEORANKER_MCP_AUTO_UPDATE = '0';
  const result = await f.host.callTool({ name: 'fixture', arguments: { action: 'error', code: 'REMOTE_SCHEMA_MISMATCH' } });
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(result.isError, true);
  assert.deepEqual(f.checkArguments, []);
  assert.deepEqual(f.logs, []);
  assert.equal(f.records.length, 1);
});

test('real worker startup preserves only an explicit bounded compatibility diagnostic', { timeout: 10_000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'georanker-supervisor-startup-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'dist/src'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  for (const [stderr, expectedCode] of [
    ['GEORANKER_WORKER_ERROR ' + JSON.stringify({ code: 'REMOTE_SCHEMA_MISMATCH', message: 'Fixture schemas are incompatible.' }) + '\n', 'REMOTE_SCHEMA_MISMATCH'],
    [JSON.stringify({ code: 'REMOTE_SCHEMA_MISMATCH', message: 'Untagged text is not a worker diagnostic.' }) + '\n', undefined],
    ['GEORANKER_WORKER_ERROR ' + JSON.stringify({ code: 'UNRELATED_PROVIDER_ERROR', message: 'Fixture provider failure.' }) + '\n', undefined],
    ['GEORANKER_WORKER_ERROR ' + JSON.stringify({ code: 'REMOTE_SCHEMA_MISMATCH', message: 'x'.repeat(8193) }) + '\n', undefined],
  ] as const) {
    await writeFile(join(root, 'dist/src/worker.js'), 'process.stderr.write(' + JSON.stringify(stderr) + ', () => process.exit(1));\n');
    await assert.rejects(createWorker(root, { PATH: process.env.PATH, GEORANKER_MCP_AUTO_UPDATE: '0' }), (error: unknown) => {
      assert.ok(error instanceof Error);
      if (expectedCode) {
        assert.equal((error as { code?: unknown }).code, expectedCode);
        assert.equal(error.message, 'Fixture schemas are incompatible.');
      }
      else assert.notEqual((error as { code?: unknown }).code, 'REMOTE_SCHEMA_MISMATCH');
      return true;
    });
  }
});
