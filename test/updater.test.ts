import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CLIENT_REPOSITORY, CLIENT_VERSION } from '../src/product.js';
import { mkdtemp, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  checkForUpdate, createReleaseVerifier, startUpdateChecks, UPDATE_CHECK_INTERVAL_MS, releaseFromStatement, rollbackRelease, selectRelease, updateDirectory, verifyArtifactDigest, verifyReleaseBundle,
  type UpdateBackend, type UpdateOptions,
} from '../src/updater.js';

const SEO_REPOSITORY = 'georanker/georanker-seo-mcp' as const;
const SCRAPING_REPOSITORY = 'georanker/georanker-web-scraping-mcp' as const;
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const DIGEST = 'c'.repeat(64);

async function fixture(t: { after(fn: () => Promise<void>): void }, repository: UpdateOptions['repository'] = SEO_REPOSITORY) {
  const { rm } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'georanker-client-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundledRoot = join(root, 'installed');
  await mkdir(bundledRoot);
  const options: UpdateOptions = {
    repository, version: '0.12.0', bundledRoot, force: true,
    env: { GEORANKER_MCP_UPDATE_DIR: join(root, 'updates') },
  };
  return { root, options };
}

function backend(options: UpdateOptions, commit = COMMIT_A, overrides: { name?: string; version?: string; invalidRuntime?: boolean; invalidLauncher?: boolean; validate?: () => Promise<void> } = {}): UpdateBackend {
  return {
    async latest() { return { commit, sha256: DIGEST }; },
    async prepare(_release, target) {
      await mkdir(join(target, 'dist', 'src'), { recursive: true });
      await writeFile(join(target, 'package.json'), JSON.stringify({
        name: overrides.name ?? (options.repository === SEO_REPOSITORY ? '@georanker/seo-mcp' : '@georanker/web-scraping-mcp'),
        version: overrides.version ?? options.version, type: 'module',
      }));
      if (!overrides.invalidLauncher) await writeFile(join(target, 'dist', 'src', 'cli.js'), 'export async function launch() {}\n');
      if (!overrides.invalidRuntime) await writeFile(join(target, 'dist', 'src', 'runtime.js'), 'export async function main() {}\n');
    },
    async validate() { await overrides.validate?.(); },
  };
}

function statement(repository = SEO_REPOSITORY) {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: 'client-update.tgz', digest: { sha256: DIGEST } }],
    predicateType: 'https://slsa.dev/provenance/v1',
    predicate: {
      buildDefinition: {
        buildType: 'https://actions.github.io/buildtypes/workflow/v1',
        externalParameters: {
          workflow: { ref: 'refs/heads/main', repository: 'https://github.com/' + repository, path: '.github/workflows/client-release.yml' },
        },
        resolvedDependencies: [{ uri: 'git+https://github.com/' + repository + '@refs/heads/main', digest: { gitCommit: COMMIT_A } }],
      },
    },
  };
}

test('a verified prepared update is selected on the next launch and a repeated commit does no work', async t => {
  const { options } = await fixture(t);
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
  const work = backend(options);
  let preparations = 0;
  const originalPrepare = work.prepare;
  work.prepare = async (...args) => { preparations++; await originalPrepare(...args); };
  const result = await checkForUpdate(options, work);
  assert.equal(result.status, 'prepared');
  assert.equal(result.commit, COMMIT_A);
  const selected = await selectRelease(options);
  assert.equal(selected.commit, COMMIT_A);
  assert.equal(selected.root, join(updateDirectory(options), 'releases', COMMIT_A));
  assert.equal(JSON.parse(await readFile(join(selected.root, 'package.json'), 'utf8')).name, '@georanker/seo-mcp');
  assert.equal((await checkForUpdate(options, work)).status, 'current');
  assert.equal(preparations, 1);
});

test('failed candidate validation leaves the working cached release selected', async t => {
  const { options } = await fixture(t);
  assert.equal((await checkForUpdate(options, backend(options))).status, 'prepared');
  const failure = await checkForUpdate(options, backend(options, COMMIT_B, {
    validate: async () => { throw new Error('Fixture validation failed'); },
  }));
  assert.equal(failure.status, 'failed');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
  const pointer = JSON.parse(await readFile(join(updateDirectory(options), 'current.json'), 'utf8'));
  assert.equal(pointer.current, COMMIT_A);
});

test('invalid release identifiers are rejected before preparation', async t => {
  const { options } = await fixture(t);
  for (const release of [
    { commit: '../escape', sha256: DIGEST },
    { commit: COMMIT_A, sha256: 'not-a-digest' },
  ]) {
    let prepared = false;
    const work = backend(options);
    work.latest = async () => release;
    work.prepare = async () => { prepared = true; };
    assert.equal((await checkForUpdate(options, work)).status, 'failed');
    assert.equal(prepared, false);
    assert.equal((await selectRelease(options)).root, options.bundledRoot);
  }
});

test('the updater rejects a different product, a version downgrade and missing runtime or launcher files', async t => {
  const { options } = await fixture(t);
  for (const overrides of [
    { name: '@georanker/web-scraping-mcp' },
    { version: '0.11.0' },
    { invalidRuntime: true },
    { invalidLauncher: true },
  ]) {
    assert.equal((await checkForUpdate(options, backend(options, COMMIT_A, overrides))).status, 'failed');
    assert.equal((await selectRelease(options)).root, options.bundledRoot);
  }
});


test('a later artifact cannot downgrade a newer cached client', async t => {
  const { options } = await fixture(t);
  assert.equal((await checkForUpdate(options, backend(options, COMMIT_A, { version: '0.13.0' }))).status, 'prepared');
  assert.equal((await checkForUpdate(options, backend(options, COMMIT_B, { version: '0.12.0' }))).status, 'failed');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
});

test('an unavailable release feed preserves the selected release', async t => {
  const { options } = await fixture(t);
  await checkForUpdate(options, backend(options));
  const work = backend(options, COMMIT_B);
  work.latest = async () => { throw new Error('Fixture network unavailable'); };
  assert.equal((await checkForUpdate(options, work)).status, 'failed');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
});

test('cached releases with a wrong product marker are ignored', async t => {
  const { options } = await fixture(t);
  await checkForUpdate(options, backend(options));
  await writeFile(join(updateDirectory(options), 'releases', COMMIT_A, '.ready.json'), JSON.stringify({
    repository: SCRAPING_REPOSITORY, commit: COMMIT_A, version: '0.12.0',
  }));
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
});

test('rollback restores the previous release and does not reactivate the rejected commit', async t => {
  const { options } = await fixture(t);
  assert.equal((await checkForUpdate(options, backend(options))).status, 'prepared');
  assert.equal((await checkForUpdate(options, backend(options, COMMIT_B))).status, 'prepared');
  assert.equal((await selectRelease(options)).commit, COMMIT_B);
  await rollbackRelease(options, COMMIT_B);
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
  const retried = await checkForUpdate(options, backend(options, COMMIT_B));
  assert.notEqual(retried.status, 'prepared');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
});

test('opting out always uses the installed bundle and performs no network or filesystem update work', async t => {
  const { root, options } = await fixture(t);
  options.env.GEORANKER_MCP_AUTO_UPDATE = '0';
  const work = backend(options);
  work.latest = async () => { throw new Error('Must not inspect the remote while disabled'); };
  assert.equal((await checkForUpdate(options, work)).status, 'disabled');
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
  assert.deepEqual(await readdir(root), ['installed']);
});

test('only one update is prepared per product at a time', { timeout: 5_000 }, async t => {
  const { options } = await fixture(t);
  let entered!: () => void;
  let release!: () => void;
  const enteredLatest = new Promise<void>(resolve => { entered = resolve; });
  const allowedToFinish = new Promise<void>(resolve => { release = resolve; });
  const work = backend(options);
  work.latest = async () => {
    entered();
    await allowedToFinish;
    return { commit: COMMIT_A, sha256: DIGEST };
  };
  const first = checkForUpdate(options, work);
  await enteredLatest;
  try {
    assert.equal((await checkForUpdate(options, backend(options, COMMIT_B))).status, 'busy');
  } finally {
    release();
  }
  assert.equal((await first).status, 'prepared');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
});

test('a displaced update worker cannot activate its release', async t => {
  const { options } = await fixture(t);
  await checkForUpdate(options, backend(options));
  const candidate = backend(options, COMMIT_B, { validate: async () => {
    await writeFile(join(updateDirectory(options), 'update.lock', 'owner.json'),
      JSON.stringify({ token: 'another-worker', pid: process.pid, createdAt: Date.now() }));
  } });
  assert.equal((await checkForUpdate(options, candidate)).status, 'failed');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
});

test('a corrupt current pointer falls back to the installed bundle', async t => {
  const { options } = await fixture(t);
  await checkForUpdate(options, backend(options));
  await writeFile(join(updateDirectory(options), 'current.json'), '{invalid');
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
  await writeFile(join(updateDirectory(options), 'current.json'), JSON.stringify({ current: '../../installed' }));
  assert.equal((await selectRelease(options)).root, options.bundledRoot);
});

test('the two product profiles cannot select or overwrite each other\'s cached release', async t => {
  const { options } = await fixture(t);
  const scraping: UpdateOptions = { ...options, repository: SCRAPING_REPOSITORY };
  assert.notEqual(updateDirectory(options), updateDirectory(scraping));
  assert.equal((await checkForUpdate(options, backend(options))).status, 'prepared');
  assert.equal((await selectRelease(scraping)).root, scraping.bundledRoot);
  assert.equal((await checkForUpdate(scraping, backend(scraping, COMMIT_B))).status, 'prepared');
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
  assert.equal((await selectRelease(scraping)).commit, COMMIT_B);
});

test('signed release metadata must identify this repository, the main release workflow and the expected artifact', () => {
  assert.deepEqual(releaseFromStatement(SEO_REPOSITORY, statement()), { commit: COMMIT_A, sha256: DIGEST });
  const mutations: Array<(value: ReturnType<typeof statement>) => void> = [
    value => { value._type = 'https://in-toto.io/Statement/v0.1'; },
    value => { value.predicateType = 'https://example.com/custom-provenance'; },
    value => { value.subject[0]!.name = 'another-artifact.tgz'; },
    value => { value.subject.push({ name: 'client-update.tgz', digest: { sha256: DIGEST } }); },
    value => { value.subject[0]!.digest.sha256 = 'broken'; },
    value => { value.predicate.buildDefinition.buildType = 'https://example.com/build'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.repository = 'https://github.com/attacker/georanker-seo-mcp'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.ref = 'refs/heads/unreviewed'; },
    value => { value.predicate.buildDefinition.externalParameters.workflow.path = '.github/workflows/other.yml'; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0]!.uri = 'git+https://github.com/attacker/georanker-seo-mcp@refs/heads/main'; },
    value => { value.predicate.buildDefinition.resolvedDependencies[0]!.digest.gitCommit = '../escape'; },
  ];
  for (const mutate of mutations) {
    const value = statement();
    mutate(value);
    assert.throws(() => releaseFromStatement(SEO_REPOSITORY, value));
  }
  assert.throws(() => releaseFromStatement(SCRAPING_REPOSITORY, statement()));
});

test('an older release already in the cache cannot replace a newer active release', async t => {
  const { options } = await fixture(t);
  await checkForUpdate(options, backend(options, COMMIT_A, { version: '0.12.0' }));
  await checkForUpdate(options, backend(options, COMMIT_B, { version: '0.13.0' }));
  assert.equal((await checkForUpdate(options, backend(options, COMMIT_A, { version: '0.12.0' }))).status, 'failed');
  assert.equal((await selectRelease(options)).commit, COMMIT_B);
});

test('an unsigned bundle cannot authorize a syntactically valid release statement', async () => {
  const bundle = {
    dsseEnvelope: {
      payloadType: 'application/vnd.in-toto+json',
      payload: Buffer.from(JSON.stringify(statement())).toString('base64'),
      signatures: [],
    },
  };
  await assert.rejects(verifyReleaseBundle(SEO_REPOSITORY, bundle), /signed workflow certificate/);
});

test('the downloaded artifact must match the digest authorized by its signed statement', () => {
  const bytes = Buffer.from('Fixture release artifact');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.doesNotThrow(() => verifyArtifactDigest(bytes, digest));
  assert.throws(() => verifyArtifactDigest(Buffer.from('Modified release artifact'), digest), /digest mismatch/);
  assert.throws(() => verifyArtifactDigest(bytes, 'malformed'), /digest mismatch/);
});


test('environment overrides cannot redirect the public update feed or attach credentials', async t => {
  const { options } = await fixture(t);
  options.env.GEORANKER_MCP_UPDATE_URL = 'https://untrusted.invalid/updates';
  options.env.GEORANKER_MCP_URL = 'https://custom-service.invalid/mcp';
  const requests: Array<{ url: string; credentials: RequestCredentials | undefined }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), credentials: init?.credentials });
    throw new Error('Fixture fetch stopped before network');
  });
  assert.equal((await checkForUpdate(options)).status, 'failed');
  assert.deepEqual(requests, [{
    url: 'https://github.com/georanker/georanker-seo-mcp/releases/latest/download/client-update.sigstore.json',
    credentials: 'omit',
  }]);
});

test('the installed entry point delegates to the prepared launcher on the next start', async t => {
  const { options } = await fixture(t, CLIENT_REPOSITORY);
  options.version = CLIENT_VERSION;
  const work = backend(options);
  const prepare = work.prepare;
  work.prepare = async (...args) => {
    await prepare(...args);
    await writeFile(join(args[1], 'dist', 'src', 'cli.js'),
      'export async function launch(bundledOnly) { if (bundledOnly !== true) throw new Error("Expected bundled delegation"); process.stdout.write("prepared-launcher\\n"); }');
  };
  assert.equal((await checkForUpdate(options, work)).status, 'prepared');
  const launched = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--version'], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, ...options.env, GEORANKER_MCP_URL: 'http://127.0.0.1:1' },
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout, 'prepared-launcher\n');
  assert.equal(launched.stderr, '');
});

test('a failed prepared launcher rolls back to the previous release with diagnostics only on stderr', async t => {
  const { root, options } = await fixture(t, CLIENT_REPOSITORY);
  options.version = CLIENT_VERSION;
  for (const [commit, script] of [
    [COMMIT_A, 'export async function launch() { process.stdout.write("previous-launcher\\n"); }'],
    [COMMIT_B, 'export async function launch() { throw new Error("Fixture startup failure"); }'],
  ]) {
    const work = backend(options, commit);
    const prepare = work.prepare;
    work.prepare = async (...args) => {
      await prepare(...args);
      await writeFile(join(args[1], 'dist', 'src', 'cli.js'), script);
    };
    assert.equal((await checkForUpdate(options, work)).status, 'prepared');
  }
  const launched = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), '--setup'], {
    encoding: 'utf8', timeout: 10_000,
    env: { PATH: process.env.PATH, ...options.env, GEORANKER_MCP_URL: 'http://127.0.0.1:1', GEORANKER_STATE_DIR: join(root, 'state') },
  });
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout, 'previous-launcher\n');
  assert.match(launched.stderr, /prepared client|previous working client|fallback/i);
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
});

test('the launcher is inert on import and still starts through an npm-style bin symlink', async t => {
  const { root, options } = await fixture(t, CLIENT_REPOSITORY);
  options.version = CLIENT_VERSION;
  const entryUrl = new URL('../src/cli.js', import.meta.url);
  const env = { PATH: process.env.PATH, ...options.env, GEORANKER_MCP_URL: 'http://127.0.0.1:1', GEORANKER_STATE_DIR: join(root, 'state') };
  const code = 'globalThis.fetch = async () => { throw new Error("Unexpected network request"); }; await import('
    + JSON.stringify(entryUrl.href) + '); process.stdout.write("imported\\n");';
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', timeout: 10_000, env });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(imported.stdout, 'imported\n');
  assert.equal(imported.stderr, '');
  const bin = join(root, 'georanker-client-bin');
  await symlink(fileURLToPath(entryUrl), bin);
  const symlinked = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 10_000, env });
  assert.equal(symlinked.status, 0, symlinked.stderr);
  assert.equal(symlinked.stdout, options.version + '\n');
  assert.equal(symlinked.stderr, '');
});

test('a rejected release is revalidated after cooldown without reinstalling its immutable files', async t => {
  const { options } = await fixture(t);
  await checkForUpdate(options, backend(options, COMMIT_A));
  await checkForUpdate(options, backend(options, COMMIT_B));
  await rollbackRelease(options, COMMIT_B);
  let validations = 0;
  let healthy = false;
  const work = backend(options, COMMIT_B);
  work.prepare = async () => { throw new Error('Cached release must not be reinstalled'); };
  work.validate = async () => {
    validations++;
    if (!healthy) throw new Error('Fixture service remains unavailable');
  };
  assert.equal((await checkForUpdate(options, work)).status, 'failed');
  assert.equal(validations, 0, 'The failed release must remain inactive during cooldown.');
  await writeFile(join(updateDirectory(options), 'rejected.json'), JSON.stringify({ commit: COMMIT_B, retryAfter: Date.now() - 1 }));
  assert.equal((await checkForUpdate(options, work)).status, 'failed');
  assert.equal(validations, 1);
  assert.equal((await selectRelease(options)).commit, COMMIT_A);
  healthy = true;
  assert.equal((await checkForUpdate(options, work)).status, 'prepared');
  assert.equal(validations, 2);
  assert.equal((await selectRelease(options)).commit, COMMIT_B);
});


test('automatic checks share a five-minute cooldown across clients, including failed checks', async t => {
  const { options } = await fixture(t);
  options.force = false;
  const work = backend(options);
  let requests = 0;
  let unavailable = false;
  work.latest = async () => {
    requests++;
    if (unavailable) throw new Error('Fixture unavailable');
    return { commit: COMMIT_A, sha256: DIGEST };
  };
  assert.equal(UPDATE_CHECK_INTERVAL_MS, 300_000);
  assert.equal((await checkForUpdate(options, work)).status, 'prepared');
  const reconnected = { ...options };
  assert.equal((await checkForUpdate(reconnected, work)).status, 'deferred');
  assert.equal(requests, 1);
  assert.equal((await checkForUpdate({ ...options, force: true }, work)).status, 'current');
  assert.equal(requests, 2, 'Explicit manual checks bypass the automatic cooldown.');
  await writeFile(join(updateDirectory(options), 'last-check.json'), JSON.stringify({ checkedAt: Date.now() - UPDATE_CHECK_INTERVAL_MS }));
  unavailable = true;
  assert.equal((await checkForUpdate(options, work)).status, 'failed');
  assert.equal((await checkForUpdate(reconnected, work)).status, 'deferred');
  assert.equal(requests, 3, 'A failed feed request is also throttled.');
});

test('invalid or future check timestamps cannot disable automatic updates', async t => {
  const { options } = await fixture(t);
  options.force = false;
  const work = backend(options);
  await checkForUpdate(options, work);
  for (const value of ['invalid json', JSON.stringify({ checkedAt: Date.now() + 1_000_000 }), JSON.stringify({ checkedAt: 'yesterday' })]) {
    await writeFile(join(updateDirectory(options), 'last-check.json'), value);
    assert.equal((await checkForUpdate(options, work)).status, 'current');
  }
});

test('routine checks and unavailable updates are silent, and only prepared updates can log', async t => {
  const { options } = await fixture(t);
  const messages: string[] = [];
  options.log = message => { messages.push(message); };
  const work = backend(options);
  assert.equal((await checkForUpdate(options, work)).status, 'prepared');
  assert.equal(messages.length, 1);
  assert.match(messages[0]!, /Verified client update/);
  messages.length = 0;
  assert.equal((await checkForUpdate(options, work)).status, 'current');
  work.latest = async () => { throw new Error('Fixture network unavailable'); };
  assert.equal((await checkForUpdate(options, work)).status, 'failed');
  assert.deepEqual(messages, []);
});

test('background polling starts immediately, repeats every five minutes, and never logs checks', { timeout: 5_000 }, async t => {
  const { options } = await fixture(t);
  let tick!: () => void;
  let interval = 0;
  let unrefs = 0;
  let cleared = false;
  t.mock.method(globalThis, 'setInterval', (callback: () => void, milliseconds: number) => {
    tick = callback;
    interval = milliseconds;
    return { unref() { unrefs++; } } as NodeJS.Timeout;
  });
  t.mock.method(globalThis, 'clearInterval', () => { cleared = true; });
  let requests = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    throw new Error('Fixture unavailable');
  });
  const messages: string[] = [];
  options.log = message => { messages.push(message); };
  const completed: string[] = [];
  let resolveCheck: (() => void) | undefined;
  const nextCheck = () => new Promise<void>(resolve => { resolveCheck = resolve; });
  let completedCheck = nextCheck();
  const stop = startUpdateChecks(options, result => {
    completed.push(result.status);
    resolveCheck?.();
  });
  t.after(stop);
  await completedCheck;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(interval, 300_000);
  assert.equal(unrefs, 1);
  assert.equal(requests, 1);
  assert.deepEqual(completed, ['failed']);
  completedCheck = nextCheck();
  tick();
  await completedCheck;
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests, 1, 'A simultaneous host or early tick must respect the shared cooldown.');
  assert.deepEqual(completed, ['failed', 'deferred']);
  await writeFile(join(updateDirectory(options), 'last-check.json'), JSON.stringify({ checkedAt: Date.now() - UPDATE_CHECK_INTERVAL_MS }));
  completedCheck = nextCheck();
  tick();
  await completedCheck;
  assert.equal(requests, 2);
  assert.deepEqual(messages, []);
  stop();
  assert.equal(cleared, true);
  tick();
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(requests, 2);
});

test('verified bundle bytes are reused only for the same product and failures never enter the cache', async () => {
  let verifications = 0;
  const verify = createReleaseVerifier(async (repository, bundle) => {
    verifications++;
    if (!bundle.valid) throw new Error('Fixture invalid signature');
    return { commit: repository === SEO_REPOSITORY ? COMMIT_A : COMMIT_B, sha256: DIGEST };
  });
  const bytes = Buffer.from(JSON.stringify({ valid: true }));
  const result = await verify(SEO_REPOSITORY, bytes);
  result.commit = COMMIT_B;
  assert.equal((await verify(SEO_REPOSITORY, bytes)).commit, COMMIT_A, 'Callers cannot mutate the cached verified result.');
  assert.equal(verifications, 1);
  assert.equal((await verify(SCRAPING_REPOSITORY, bytes)).commit, COMMIT_B);
  assert.equal(verifications, 2, 'A different repository must verify independently.');
  await verify(SEO_REPOSITORY, Buffer.from(JSON.stringify({ valid: true, changed: true })));
  assert.equal(verifications, 3, 'Any changed signed bytes must be verified again.');
  const invalid = Buffer.from(JSON.stringify({ valid: false }));
  await assert.rejects(verify(SEO_REPOSITORY, invalid), /invalid signature/);
  await assert.rejects(verify(SEO_REPOSITORY, invalid), /invalid signature/);
  assert.equal(verifications, 5);
  await assert.rejects(verify('untrusted/repository', bytes), /Unsupported update repository/);
  assert.equal(verifications, 5);
});
