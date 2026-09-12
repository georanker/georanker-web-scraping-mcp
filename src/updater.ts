// Only signed release artifacts from the fixed public main workflow may be installed.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, devNull } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const WORKFLOW = '.github/workflows/client-release.yml';
const ARTIFACT = 'client-update.tgz';
export const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REPOSITORIES = new Map([
  ['georanker/georanker-seo-mcp', '@georanker/seo-mcp'],
  ['georanker/georanker-web-scraping-mcp', '@georanker/web-scraping-mcp'],
]);
export interface UpdateOptions {
  repository: string;
  version: string;
  bundledRoot: string;
  env: NodeJS.ProcessEnv;
  log?: (message: string) => unknown;
  signal?: AbortSignal;
  // Only an explicit manual check should bypass the shared per-product cooldown.
  force?: boolean;
}
interface Pointer { current: string; previous?: string }
interface Ready { repository: string; commit: string; version: string }
export interface SignedRelease { commit: string; sha256: string }
export type UpdateResult = { status: 'disabled' | 'busy' | 'current' | 'prepared' | 'failed' | 'deferred'; commit?: string; version?: string };
export function updateDirectory(options: UpdateOptions): string {
  if (!REPOSITORIES.has(options.repository)) throw new Error('Unsupported update repository');
  return join(options.env.GEORANKER_MCP_UPDATE_DIR || join(homedir(), '.config', 'georanker-mcp-updates'), options.repository.split('/')[1]);
}
function enabled(options: UpdateOptions): boolean { return options.env.GEORANKER_MCP_AUTO_UPDATE !== '0'; }
function older(candidate: string, bundled: string): boolean {
  if (!/^\d+\.\d+\.\d+$/.test(candidate) || !/^\d+\.\d+\.\d+$/.test(bundled)) throw new Error('Unsupported client version');
  const a = candidate.split('.').map(Number), b = bundled.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] < b[i]; }
  return false;
}
async function readPointer(directory: string): Promise<Pointer | undefined> {
  try {
    const value = JSON.parse(await readFile(join(directory, 'current.json'), 'utf8')) as Pointer;
    return SHA.test(value.current) && (!value.previous || SHA.test(value.previous)) ? value : undefined;
  } catch { return undefined; }
}
async function ready(options: UpdateOptions, commit: string): Promise<Ready | undefined> {
  if (!SHA.test(commit)) return undefined;
  try {
    const root = join(updateDirectory(options), 'releases', commit);
    const value = JSON.parse(await readFile(join(root, '.ready.json'), 'utf8')) as Ready;
    if (value.repository !== options.repository || value.commit !== commit || older(value.version, options.version)) return undefined;
    await access(join(root, 'dist/src/runtime.js'));
    await access(join(root, 'dist/src/cli.js'));
    return value;
  } catch { return undefined; }
}
export async function selectRelease(options: UpdateOptions): Promise<{ root: string; commit?: string }> {
  if (enabled(options)) {
    const pointer = await readPointer(updateDirectory(options));
    for (const commit of [pointer?.current, pointer?.previous]) {
      if (commit && await ready(options, commit)) return { root: join(updateDirectory(options), 'releases', commit), commit };
    }
  }
  return { root: options.bundledRoot };
}
async function writePointer(directory: string, pointer: Pointer): Promise<void> {
  const temp = join(directory, 'pointer-' + randomUUID() + '.tmp');
  await writeFile(temp, JSON.stringify(pointer) + '\n', { mode: 0o600 });
  await rename(temp, join(directory, 'current.json'));
}
export async function rollbackRelease(options: UpdateOptions, commit: string): Promise<void> {
  try {
    const directory = updateDirectory(options), pointer = await readPointer(directory);
    if (pointer?.current !== commit) return;
    await writeFile(join(directory, 'rejected.json'), JSON.stringify({ commit, retryAfter: Date.now() + 15 * 60 * 1000 }), { mode: 0o600 });
    if (pointer.previous && await ready(options, pointer.previous)) await writePointer(directory, { current: pointer.previous });
    else await rm(join(directory, 'current.json'), { force: true });
  } catch { options.log?.('Could not record rollback; the bundled client remains available.'); }
}
// This policy is evaluated only after Sigstore verifies the certificate, signature,
// transparency inclusion and exact workflow identity. No statement field is trusted first.
export function releaseFromStatement(repository: string, statement: unknown): SignedRelease {
  if (!REPOSITORIES.has(repository)) throw new Error('Unsupported update repository');
  const s = statement as any;
  const definition = s?.predicate?.buildDefinition;
  const workflow = definition?.externalParameters?.workflow;
  const source = 'https://github.com/' + repository;
  const subject = s?.subject;
  if (s?._type !== 'https://in-toto.io/Statement/v1' || s?.predicateType !== 'https://slsa.dev/provenance/v1' ||
      definition?.buildType !== 'https://actions.github.io/buildtypes/workflow/v1' ||
      workflow?.repository !== source || workflow?.ref !== 'refs/heads/main' || workflow?.path !== WORKFLOW ||
      !Array.isArray(subject) || subject.length !== 1 || subject[0]?.name !== ARTIFACT || !DIGEST.test(subject[0]?.digest?.sha256)) {
    throw new Error('Release provenance does not match the approved product workflow');
  }
  const dependency = definition?.resolvedDependencies?.find((item: any) => item.uri === 'git+' + source + '@refs/heads/main');
  const commit = dependency?.digest?.gitCommit;
  if (!SHA.test(commit)) throw new Error('Release provenance lacks an immutable source commit');
  return { commit, sha256: subject[0].digest.sha256 };
}
async function download(url: string, limit: number, signal?: AbortSignal): Promise<Buffer> {
  const timeout = AbortSignal.timeout(30000);
  const response = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout, credentials: 'omit' });
  if (!response.ok || !response.body || !response.url.startsWith('https://')) throw new Error('Update download unavailable');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body as any) {
    size += chunk.length;
    if (size > limit) throw new Error('Update exceeds size limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
// The cache stores only the most recent fully verified bundle per product. Reusing
// identical signed bytes avoids repeated Sigstore trust-root requests during polling.
// Verification failures never enter the cache; the cache does not survive a restart.
export function createReleaseVerifier(verify: typeof verifyReleaseBundle = verifyReleaseBundle):
  (repository: string, bytes: Buffer) => Promise<SignedRelease> {
  const verified = new Map<string, { digest: string; release: SignedRelease }>();
  return async (repository, bytes) => {
    if (!REPOSITORIES.has(repository)) throw new Error('Unsupported update repository');
    const digest = createHash('sha256').update(bytes).digest('hex');
    const cached = verified.get(repository);
    if (cached?.digest === digest) return { ...cached.release };
    const release = await verify(repository, JSON.parse(bytes.toString('utf8')));
    verified.set(repository, { digest, release: { ...release } });
    return { ...release };
  };
}
const verifyLatest = createReleaseVerifier();
async function signedLatest(options: UpdateOptions): Promise<SignedRelease> {
  const bytes = await download('https://github.com/' + options.repository + '/releases/latest/download/client-update.sigstore.json', 1024 * 1024, options.signal);
  return verifyLatest(options.repository, bytes);
}
export async function verifyReleaseBundle(repository: string, bundle: any): Promise<SignedRelease> {
  if (!REPOSITORIES.has(repository)) throw new Error('Unsupported update repository');
  if (!bundle?.verificationMaterial?.certificate && !bundle?.verificationMaterial?.x509CertificateChain) throw new Error('Expected a signed workflow certificate');
  if (!bundle.dsseEnvelope || bundle.dsseEnvelope.payloadType !== 'application/vnd.in-toto+json') throw new Error('Expected signed provenance');
  const { verify } = await import('sigstore');
  const identity = 'https://github.com/' + repository + '/' + WORKFLOW + '@refs/heads/main';
  await verify(bundle, {
    certificateIssuer: 'https://token.actions.githubusercontent.com',
    certificateIdentityURI: '^' + identity.replace(/[.*+?^$()|[\]\\]/g, '\\$&') + '$',
    tlogThreshold: 1, ctLogThreshold: 1,
  });
  return releaseFromStatement(repository, JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, 'base64').toString('utf8')));
}
export function verifyArtifactDigest(bytes: Buffer, sha256: string): void {
  if (!DIGEST.test(sha256) || createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('Release digest mismatch');
}
function installEnvironment(options: UpdateOptions): NodeJS.ProcessEnv {
  // No provider keys or installation credentials reach dependency installation.
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA']) {
    if (options.env[name]) env[name] = options.env[name];
  }
  env.PATH = dirname(process.execPath) + delimiter + (env.PATH || '');
  env.npm_config_userconfig = join(updateDirectory(options), 'empty-user.npmrc');
  env.npm_config_globalconfig = devNull;
  return env;
}
async function npmCli(): Promise<string> {
  const nodeDirectory = dirname(process.execPath);
  for (const candidate of [resolve(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'), resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js')]) {
    try { await access(candidate); return candidate; } catch {}
  }
  throw new Error('npm is unavailable beside Node');
}
async function prepareSigned(options: UpdateOptions, release: SignedRelease, target: string): Promise<void> {
  const bytes = await download('https://github.com/' + options.repository + '/releases/download/client-' + release.commit + '/' + ARTIFACT, 20 * 1024 * 1024, options.signal);
  verifyArtifactDigest(bytes, release.sha256);
  // Signature + digest checks precede archive parsing and any code/dependency execution.
  const file = join(target, ARTIFACT);
  await writeFile(file, bytes, { mode: 0o600 });
  const tar = await import('tar');
  let safe = true;
  await tar.t({ file, onReadEntry: entry => {
    const path = entry.path;
    if (!['File', 'Directory'].includes(entry.type) || !path.startsWith('package/') || path.includes('\\') || path.split('/').includes('..')) safe = false;
  } });
  if (!safe) throw new Error('Unsafe release archive');
  await tar.x({ file, cwd: target, strip: 1, strict: true, preservePaths: false });
  await rm(file);
  await access(join(target, 'npm-shrinkwrap.json'));
}
async function validateInstalled(options: UpdateOptions, target: string): Promise<void> {
  const env = installEnvironment(options);
  await writeFile(env.npm_config_userconfig!, '', { mode: 0o600 });
  const npm = await npmCli();
  await exec(process.execPath, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--cache', join(updateDirectory(options), 'npm-cache')],
    { cwd: target, env, timeout: 120000, maxBuffer: 4 * 1024 * 1024, signal: options.signal, windowsHide: true });
  await validateConnection(options, target);
}
async function validateConnection(options: UpdateOptions, target: string): Promise<void> {
  // Disable BOTH selection and background checks to validate this exact candidate.
  // Setup checks enrollment/schemas, never a provider data query.
  await exec(process.execPath, [join(target, 'dist/src/cli.js'), '--setup'],
    { cwd: target, env: { ...options.env, PATH: installEnvironment(options).PATH, GEORANKER_MCP_AUTO_UPDATE: '0' }, timeout: 30000, maxBuffer: 1024 * 1024, signal: options.signal, windowsHide: true });
}
interface UpdateLock { release(): Promise<void>; assertHeld(): Promise<void> }
async function acquire(directory: string): Promise<UpdateLock | undefined> {
  const lock = join(directory, 'update.lock'), token = randomUUID();
  try { await mkdir(lock); }
  catch {
    try {
      if (Date.now() - (await stat(lock)).mtimeMs < 600000) return undefined;
      let owner: { pid: number } | undefined;
      try { owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8')); } catch {}
      if (owner && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try { process.kill(owner.pid, 0); return undefined; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return undefined; }
      }
      await rm(lock, { recursive: true, force: true }); await mkdir(lock);
    } catch { return undefined; }
  }
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid, createdAt: Date.now() }), { mode: 0o600 });
  return {
    async assertHeld() {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (owner.token !== token) throw new Error('Update lock ownership changed');
    },
    async release() {
      const owner = JSON.parse(await readFile(join(lock, 'owner.json'), 'utf8'));
      if (owner.token === token) await rm(lock, { recursive: true, force: true });
    },
  };
}
// Synthetic backend injection is available only to tests, never via CLI or environment.
export interface UpdateBackend {
  latest(): Promise<SignedRelease>;
  prepare(release: SignedRelease, target: string): Promise<void>;
  validate(target: string): Promise<void>;
}
export async function checkForUpdate(options: UpdateOptions, fixture?: UpdateBackend): Promise<UpdateResult> {
  if (!enabled(options)) return { status: 'disabled' };
  let lock: UpdateLock | undefined, staging: string | undefined;
  try {
    const directory = updateDirectory(options);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await mkdir(join(directory, 'releases'), { recursive: true, mode: 0o700 });
    lock = await acquire(directory);
    if (!lock) return { status: 'busy' };
    const now = Date.now();
    if (!options.force) {
      try {
        const previous = JSON.parse(await readFile(join(directory, 'last-check.json'), 'utf8'));
        if (Number.isSafeInteger(previous.checkedAt) && previous.checkedAt <= now &&
            now - previous.checkedAt < UPDATE_CHECK_INTERVAL_MS) return { status: 'deferred' };
      } catch {}
    }
    // Record attempts before network work, including failures, so reconnects and
    // simultaneous hosts cannot multiply release-feed requests.
    await lock.assertHeld();
    await writeFile(join(directory, 'last-check.json'), JSON.stringify({ checkedAt: now }) + '\n', { mode: 0o600 });
    const backend: UpdateBackend = fixture || {
      latest: () => signedLatest(options),
      prepare: (release, target) => prepareSigned(options, release, target),
      validate: target => validateInstalled(options, target),
    };
    const release = await backend.latest(), commit = release.commit;
    if (!SHA.test(commit) || !DIGEST.test(release.sha256)) throw new Error('Invalid signed release');
    const pointer = await readPointer(directory);
    if (pointer?.current === commit && await ready(options, commit)) return { status: 'current', commit };
    let retryRejected = false;
    try {
      const rejected = JSON.parse(await readFile(join(directory, 'rejected.json'), 'utf8'));
      if (rejected.commit === commit) {
        if (rejected.retryAfter > Date.now()) return { status: 'failed', commit };
        retryRejected = true;
      }
    } catch {}
    const existing = await ready(options, commit);
    let version = existing?.version;
    const currentVersion = pointer?.current ? (await ready(options, pointer.current))?.version : undefined;
    const versionFloor = currentVersion && !older(currentVersion, options.version) ? currentVersion : options.version;
    if (version && older(version, versionFloor)) throw new Error('Cached update is older than the active client');
    // A temporary hosted outage must not blacklist a valid signed release forever.
    // Revalidate after cooldown without changing its immutable dependency tree.
    if (existing && retryRejected) {
      const candidate = join(directory, 'releases', commit);
      if (fixture) await fixture.validate(candidate);
      else await validateConnection(options, candidate);
    }
    if (!existing) {
      staging = await mkdtemp(join(directory, 'staging-'));
      await backend.prepare(release, staging);
      const manifest = JSON.parse(await readFile(join(staging, 'package.json'), 'utf8'));
      if (manifest.name !== REPOSITORIES.get(options.repository)) throw new Error('Update product mismatch');
      version = manifest.version;
      if (typeof version !== 'string' || older(version, versionFloor)) throw new Error('Update is older than the active client');
      await backend.validate(staging);
      await access(join(staging, 'dist/src/runtime.js'));
      await access(join(staging, 'dist/src/cli.js'));
      await writeFile(join(staging, '.ready.json'), JSON.stringify({ repository: options.repository, commit, version, sha256: release.sha256 }), { mode: 0o600 });
      await lock.assertHeld();
      await rename(staging, join(directory, 'releases', commit));
      staging = undefined;
    }
    await lock.assertHeld();
    const active = await readPointer(directory);
    const activeVersion = active?.current ? (await ready(options, active.current))?.version : undefined;
    if (activeVersion && version && older(version, activeVersion)) throw new Error('A newer client was activated during this update');
    await lock.assertHeld();
    await writePointer(directory, { current: commit, ...(active?.current && active.current !== commit ? { previous: active.current } : {}) });
    options.log?.('Verified client update ' + version + ' is ready to apply when idle.');
    return { status: 'prepared', commit, version };
  } catch {
    return { status: 'failed' };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true }).catch(() => {});
    if (lock) await lock.release().catch(() => {});
  }
}
export function startUpdateChecks(options: UpdateOptions, onChecked?: (result: UpdateResult) => void | Promise<void>): () => void {
  if (!enabled(options)) return () => {};
  const controller = new AbortController();
  let running = false;
  const check = async () => {
    if (running || controller.signal.aborted) return;
    running = true;
    try {
      const result = await checkForUpdate({ ...options, signal: controller.signal, force: false, log: undefined });
      if (!controller.signal.aborted) await onChecked?.(result);
    } catch {
      // Optional background housekeeping must not interrupt the MCP or log checks.
    } finally { running = false; }
  };
  void check();
  const timer = setInterval(() => { void check(); }, UPDATE_CHECK_INTERVAL_MS);
  timer.unref();
  return () => { clearInterval(timer); controller.abort(); };
}
