import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ErrorCode, McpError, ResultSchema, type ServerCapabilities } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { resolve } from 'node:path';
import { checkForUpdate, rollbackRelease, selectRelease, startUpdateChecks, type UpdateOptions, type UpdateResult } from './updater.js';

export interface Worker {
  root: string;
  client: Client;
  close(): Promise<void>;
}
export interface SupervisorDependencies {
  createWorker?: (root: string) => Promise<Worker>;
  check?: () => Promise<UpdateResult>;
  select?: () => Promise<{ root: string; commit?: string }>;
  now?: () => number;
  idleMs?: number;
  automaticChecks?: boolean;
}
const canonical = (value: unknown): string => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item);

export async function createWorker(root: string, environment: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<Worker> {
  const env = Object.fromEntries(Object.entries({ ...environment, GEORANKER_MCP_AUTO_UPDATE: '0' })
    .filter((entry): entry is [string, string] => entry[1] !== undefined));
  const client = new Client({ name: 'georanker-client-supervisor', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath, args: [resolve(root, 'dist/src/worker.js')], env, stderr: 'pipe',
  });
  transport.stderr?.on('data', () => {}); // Routine worker/setup output stays private.
  const abort = () => { void client.close().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    if (signal?.aborted) throw new Error('Supervisor closed');
    await client.connect(transport, { timeout: 30000 });
    if (signal?.aborted) throw new Error('Supervisor closed');
    return { root, client, async close() {
      signal?.removeEventListener('abort', abort);
      await client.close();
    } };
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    await client.close().catch(() => {});
    throw error;
  }
}

export class Supervisor {
  readonly server: Server;
  private active: Worker;
  private pending?: { root: string; commit?: string; recovery?: boolean };
  private count = 0;
  private lastActivity: number;
  private cancelled = false;
  private activeDead = false;
  private closed = false;
  private switching = false;
  private initialized = false;
  private idleTimer?: NodeJS.Timeout;
  private stopChecks?: () => void;
  private readonly now: () => number;
  private readonly idleMs: number;
  private readonly factory: (root: string) => Promise<Worker>;
  private readonly capabilities: ServerCapabilities;
  private readonly shutdown: AbortController;
  private readonly reconnectRoots = new Set<string>();

  private constructor(
    private readonly options: UpdateOptions,
    private readonly dependencies: SupervisorDependencies,
    worker: Worker,
    shutdown: AbortController,
    factory: (root: string) => Promise<Worker>,
  ) {
    this.active = worker;
    this.shutdown = shutdown;
    this.factory = factory;
    this.now = dependencies.now || Date.now;
    this.idleMs = dependencies.idleMs ?? 60000;
    this.lastActivity = this.now();
    this.capabilities = worker.client.getServerCapabilities() || {};
    this.server = new Server(worker.client.getServerVersion() || { name: 'georanker-supervisor', version: options.version }, {
      capabilities: this.capabilities, instructions: worker.client.getInstructions(),
    });
    this.bind(worker);
    this.server.fallbackRequestHandler = async (request, extra) => {
      if (this.closed) throw new Error('MCP supervisor closed');
      const target = this.active;
      this.count++;
      this.lastActivity = this.now();
      // Cancellation may resolve locally before upstream completion is certain.
      // Keep this worker for the session rather than interrupting or replaying work.
      const cancelled = () => { this.cancelled = true; };
      extra.signal.addEventListener('abort', cancelled, { once: true });
      if (extra.signal.aborted) cancelled();
      try {
        const progressToken = request.params?._meta?.progressToken;
        return await target.client.request({ method: request.method, params: request.params }, ResultSchema, {
          signal: extra.signal, timeout: 110000,
          ...(progressToken !== undefined ? { onprogress: progress => {
            void extra.sendNotification({ method: 'notifications/progress', params: { ...progress, progressToken } }).catch(() => {});
          } } : {}),
        });
      } catch (error) {
        if (error instanceof McpError && error.code === ErrorCode.RequestTimeout) this.cancelled = true;
        throw error;
      } finally {
        extra.signal.removeEventListener('abort', cancelled);
        this.count--;
        this.lastActivity = this.now();
        this.scheduleIdle();
      }
    };
    this.server.fallbackNotificationHandler = async notification => {
      if (!this.closed) await this.active.client.notification(notification).catch(() => {});
    };
    this.server.oninitialized = () => {
      this.initialized = true;
      if (dependencies.automaticChecks !== false) {
        this.stopChecks = startUpdateChecks({ ...options, log: undefined }, () => this.acceptPrepared());
      }
    };
    this.server.onclose = () => { void this.close(); };
  }

  static async create(options: UpdateOptions, dependencies: SupervisorDependencies = {}): Promise<Supervisor> {
    const shutdown = new AbortController();
    const factory = dependencies.createWorker || (root => createWorker(root, options.env, shutdown.signal));
    const worker = await factory(options.bundledRoot);
    try {
      await worker.client.listTools();
      return new Supervisor(options, dependencies, worker, shutdown, factory);
    } catch (error) { await worker.close(); throw error; }
  }

  get activeRequests(): number { return this.count; }
  get workerRoot(): string { return this.active.root; }

  async connect(transport: Transport): Promise<void> {
    await this.server.connect(transport);
  }
  private bind(worker: Worker): void {
    worker.client.fallbackNotificationHandler = async notification => {
      if (this.active === worker && this.initialized && !this.closed) {
        await this.server.notification(notification).catch(() => {});
      }
    };
    const previousClose = worker.client.onclose;
    worker.client.onclose = () => {
      try { previousClose?.(); } catch { /* A consumer callback must not prevent recovery. */ }
      if (this.active === worker && !this.closed) {
        // Future calls can use a fresh worker. Submitted calls are never replayed.
        this.activeDead = true;
        this.pending ||= { root: worker.root, recovery: true };
        this.scheduleIdle();
      }
    };
  }
  async checkNow(): Promise<void> {
    if (this.closed) return;
    try {
      await (this.dependencies.check || (() => checkForUpdate({ ...this.options, force: false, log: undefined })))();
    } catch { /* Routine unavailable checks are silent. */ }
    await this.acceptPrepared();
  }
  private async acceptPrepared(): Promise<void> {
    if (this.closed) return;
    try {
      const selected = await (this.dependencies.select || (() => selectRelease(this.options)))();
      if (selected.root !== this.active.root && selected.commit && !this.reconnectRoots.has(selected.root)) this.pending = selected;
      await this.applyIfIdle();
      this.scheduleIdle();
    } catch { /* A missing/unavailable update never disrupts the current session. */ }
  }
  private idle(): boolean {
    return !this.closed && this.count === 0 && (this.activeDead || (!this.cancelled && this.now() - this.lastActivity >= this.idleMs));
  }
  private scheduleIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.pending || this.closed || (!this.activeDead && this.cancelled) || this.count > 0) return;
    this.idleTimer = setTimeout(() => { void this.applyIfIdle(); }, this.activeDead ? 1 : Math.max(1, this.idleMs - (this.now() - this.lastActivity)));
    this.idleTimer.unref();
  }
  async applyIfIdle(): Promise<void> {
    if (!this.pending || this.switching || !this.idle()) return;
    const pending = this.pending;
    this.switching = true;
    let candidate: Worker | undefined;
    try {
      candidate = await this.factory(pending.root);
      await candidate.client.listTools();
      if (!candidate.client.transport) throw new Error('Updated worker disconnected during preparation');
      if (canonical(candidate.client.getServerCapabilities() || {}) !== canonical(this.capabilities)) {
        // Keep a valid prepared release available to a fresh host negotiation.
        this.reconnectRoots.add(pending.root);
        if (this.pending === pending) this.pending = undefined;
        return;
      }
      // New requests may have arrived while the candidate was initializing.
      // Commit the swap synchronously only after checking the full idle condition again.
      if (!this.idle() || this.pending !== pending) return;
      const previous = this.active;
      this.active = candidate;
      this.activeDead = false;
      this.cancelled = false;
      candidate = undefined;
      this.bind(this.active);
      this.pending = undefined;
      this.lastActivity = this.now();
      // The host transport is unchanged. Its next request is forwarded to the new worker.
      await previous.close().catch(() => {});
      if (this.initialized) await this.server.sendToolListChanged().catch(() => {});
      if (!pending.recovery) {
        try { this.options.log?.('Applied verified client update ' + this.active.client.getServerVersion()?.version + ' while idle.'); }
        catch { /* Logging cannot undo an applied update. */ }
      }
    } catch {
      if (pending.commit && !this.closed) await rollbackRelease(this.options, pending.commit);
      if (this.pending === pending) this.pending = undefined;
    } finally {
      if (candidate) await candidate.close().catch(() => {});
      this.switching = false;
      this.scheduleIdle();
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopChecks?.();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.shutdown.abort();
    await this.active.close().catch(() => {});
    await this.server.close().catch(() => {});
  }
}

export const createSupervisor = (options: UpdateOptions, dependencies?: SupervisorDependencies): Promise<Supervisor> =>
  Supervisor.create(options, dependencies);
