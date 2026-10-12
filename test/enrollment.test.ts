import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import fsPromises, { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { type TestContext } from 'node:test';
import { installationHeaders } from '../src/enrollment.js';
import { newIdentity, type InstallationIdentity } from '../src/identity.js';
import { PILOT_MCP_URL, RemoteService } from '../src/remote.js';

const oldOrigin = 'https://grmcp.ibl.ro';
const newOrigin = 'https://mcp.georanker.com';
const fingerprint = 'a'.repeat(64);
function credentials(identity: InstallationIdentity) {
  const hex = createHash('sha256').update(identity.publicKey).digest('hex');
  return { installationId: `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`, accessToken: createHash('sha256').update('token:' + identity.publicKey).digest('base64url') };
}
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'georanker-client-origin-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = (origin: string) => join(root, 'client', createHash('sha256').update(origin).digest('hex'));
  const calls: Array<{ origin: string; publicKey: string }> = [];
  let revoked = false;
  t.mock.method(globalThis, 'fetch', async (url: URL, init: RequestInit) => {
    assert.equal(url.pathname, '/v1/installations');
    assert.equal(init.redirect, 'error');
    const proof = JSON.parse(String(init.body));
    const origin = url.origin;
    const key = createPublicKey({ key: Buffer.from(proof.publicKey, 'base64url'), format: 'der', type: 'spki' });
    const message = Buffer.from(JSON.stringify(['georanker-installation-v1', origin, proof.publicKey, proof.deviceFingerprint, proof.timestamp, proof.nonce]));
    assert.equal(verify(null, message, key, Buffer.from(proof.signature, 'base64url')), true);
    calls.push({ origin, publicKey: proof.publicKey });
    if (revoked) return new Response('{}', { status: 401 });
    return new Response(JSON.stringify(credentials(proof)), { status: 201 });
  });
  async function save(origin: string, identity?: InstallationIdentity, credential?: ReturnType<typeof credentials>) {
    await mkdir(dir(origin), { recursive: true, mode: 0o700 });
    if (identity) await writeFile(join(dir(origin), 'identity.json'), JSON.stringify(identity), { mode: 0o600 });
    if (credential) await writeFile(join(dir(origin), 'credentials.json'), JSON.stringify(credential), { mode: 0o600 });
  }
  const env = { GEORANKER_STATE_DIR: root, GEORANKER_DEVICE_FINGERPRINT: fingerprint };
  const connect = (origin = newOrigin, path = '/seo/mcp') => installationHeaders(new URL(path, origin), env);
  return { root, dir, calls, save, env, connect, revoke: () => { revoked = true; } };
}

test('new defaults reuse complete old state without enrollment or changes to old files', async t => {
  assert.equal(PILOT_MCP_URL, newOrigin + '/mcp');
  const f = await fixture(t);
  const identity = newIdentity(fingerprint), credential = credentials(identity);
  await f.save(oldOrigin, identity, credential);
  const before = await Promise.all(['identity.json', 'credentials.json'].map(name => readFile(join(f.dir(oldOrigin), name), 'utf8')));
  const headers = await f.connect();
  assert.equal(headers.Authorization, 'Bearer ' + credential.accessToken);
  assert.equal(headers['X-GeoRanker-Installation-Id'], credential.installationId);
  assert.deepEqual(await f.connect(newOrigin, '/scraping/mcp'), headers);
  assert.deepEqual(await f.connect(oldOrigin), headers);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await Promise.all(['identity.json', 'credentials.json'].map(name => readFile(join(f.dir(oldOrigin), name), 'utf8'))), before);
  await assert.rejects(readdir(f.dir(newOrigin)), { code: 'ENOENT' });
});

test('matching destination state is preserved and new-only complete state is imported atomically', async t => {
  const f = await fixture(t);
  const identity = newIdentity(fingerprint), credential = credentials(identity);
  await f.save(newOrigin, identity, credential);
  const before = await readFile(join(f.dir(newOrigin), 'identity.json'), 'utf8');
  const headers = await f.connect();
  assert.equal(headers['X-GeoRanker-Installation-Id'], credential.installationId);
  assert.deepEqual(JSON.parse(await readFile(join(f.dir(oldOrigin), 'identity.json'), 'utf8')), identity);
  assert.deepEqual(await f.connect(oldOrigin), headers);
  assert.equal(await readFile(join(f.dir(newOrigin), 'identity.json'), 'utf8'), before);
  assert.equal(f.calls.length, 0);
});

test('different identities, credential conflicts, corruption and credential-only partial states fail closed', async t => {
  for (const kind of ['different-identity', 'different-credentials', 'corrupt-new-identity', 'corrupt-old-identity', 'corrupt-new-credentials', 'orphan-new-credentials', 'orphan-old-credentials', 'mismatched-keypair']) {
    await t.test(kind, async child => {
      const f = await fixture(child);
      const identity = newIdentity(fingerprint), credential = credentials(identity);
      if (kind !== 'orphan-old-credentials') await f.save(oldOrigin, identity, credential);
      if (kind === 'different-identity') { const other = newIdentity(fingerprint); await f.save(newOrigin, other, credentials(other)); }
      if (kind === 'different-credentials') await f.save(newOrigin, identity, { ...credential, accessToken: 'b'.repeat(43) });
      if (kind === 'corrupt-new-identity') { await f.save(newOrigin); await writeFile(join(f.dir(newOrigin), 'identity.json'), '{'); }
      if (kind === 'corrupt-old-identity') await writeFile(join(f.dir(oldOrigin), 'identity.json'), '{');
      if (kind === 'corrupt-new-credentials') { await f.save(newOrigin, identity); await writeFile(join(f.dir(newOrigin), 'credentials.json'), '{'); }
      if (kind === 'orphan-new-credentials') await f.save(newOrigin, undefined, credential);
      if (kind === 'orphan-old-credentials') await f.save(oldOrigin, undefined, credential);
      if (kind === 'mismatched-keypair') await f.save(newOrigin, { ...identity, publicKey: newIdentity(fingerprint).publicKey });
      const before = await readFile(join(f.dir(oldOrigin), kind === 'orphan-old-credentials' ? 'credentials.json' : 'identity.json'), 'utf8');
      await assert.rejects(f.connect(), { code: 'STATE_ERROR' });
      assert.equal(f.calls.length, 0);
      assert.equal(await readFile(join(f.dir(oldOrigin), kind === 'orphan-old-credentials' ? 'credentials.json' : 'identity.json'), 'utf8'), before);
    });
  }
});

test('missing credentials recover the same old or alias-only identity at the new signed origin', async t => {
  for (const origin of [oldOrigin, newOrigin]) await t.test(origin, async child => {
    const f = await fixture(child), identity = newIdentity(fingerprint);
    await f.save(origin, identity);
    const headers = await f.connect();
    assert.equal(headers['X-GeoRanker-Installation-Id'], credentials(identity).installationId);
    assert.deepEqual(f.calls, [{ origin: newOrigin, publicKey: identity.publicKey }]);
    assert.deepEqual(JSON.parse(await readFile(join(f.dir(origin), 'identity.json'), 'utf8')), identity);
    assert.deepEqual(await f.connect(oldOrigin), headers);
  });
});

test('revoked identity recovery fails without replacing identity or publishing a token', async t => {
  const f = await fixture(t), identity = newIdentity(fingerprint);
  await f.save(oldOrigin, identity);
  f.revoke();
  await assert.rejects(f.connect(), error => {
    assert.equal((error as { code: string }).code, 'ENROLLMENT_FAILED');
    assert.match((error as Error).message, /HTTP 401/);
    return true;
  });
  assert.deepEqual(JSON.parse(await readFile(join(f.dir(oldOrigin), 'identity.json'), 'utf8')), identity);
  await assert.rejects(readFile(join(f.dir(oldOrigin), 'credentials.json')), { code: 'ENOENT' });
});

test('concurrent fresh SEO, scraping and old-host launches share one installation and credentials', async t => {
  const f = await fixture(t);
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => f.connect(i % 3 ? newOrigin : oldOrigin, i % 2 ? '/seo/mcp' : '/scraping/mcp')));
  for (const headers of results) assert.deepEqual(headers, results[0]);
  assert.equal(new Set(f.calls.map(call => call.publicKey)).size, 1);
  assert.equal((await readdir(join(f.root, 'client'))).length, 1);
  assert.deepEqual(await readdir(f.dir(oldOrigin)), ['credentials.json', 'identity.json']);
});

test('identity missing on the first read recovers a concurrently published complete installation', async t => {
  const f = await fixture(t), identity = newIdentity(fingerprint), credential = credentials(identity);
  const identityPath = join(f.dir(oldOrigin), 'identity.json');
  const originalRead = fsPromises.readFile;
  let forcedInterleaving = false;
  const mock = t.mock.method(fsPromises, 'readFile', async (path: any, options: any) => {
    if (path === identityPath && !forcedInterleaving) {
      forcedInterleaving = true;
      // Model the initial ENOENT completing after an older launcher has
      // atomically published both files, before the credentials read starts.
      await f.save(oldOrigin, identity, credential);
      throw Object.assign(new Error('Synthetic initial missing identity'), { code: 'ENOENT' });
    }
    return originalRead(path, options);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  const headers = await f.connect();
  assert.equal(forcedInterleaving, true);
  assert.equal(headers['X-GeoRanker-Installation-Id'], credential.installationId);
  assert.equal(headers.Authorization, 'Bearer ' + credential.accessToken);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(JSON.parse(await readFile(identityPath, 'utf8')), identity);
});

test('a conflicting legacy identity published by an older launcher is preserved and rejected', async t => {
  const f = await fixture(t), aliasIdentity = newIdentity(fingerprint), olderIdentity = newIdentity(fingerprint);
  await f.save(newOrigin, aliasIdentity, credentials(aliasIdentity));
  const pending = f.connect();
  mkdirSync(f.dir(oldOrigin), { recursive: true });
  writeFileSync(join(f.dir(oldOrigin), 'identity.json'), JSON.stringify(olderIdentity), { mode: 0o600 });
  await assert.rejects(pending, { code: 'STATE_ERROR' });
  assert.deepEqual(JSON.parse(await readFile(join(f.dir(oldOrigin), 'identity.json'), 'utf8')), olderIdentity);
  assert.equal(f.calls.length, 0);
});

test('custom origins keep independent namespaces and explicit old overrides still contact the old host', async t => {
  const f = await fixture(t);
  await f.connect(oldOrigin);
  assert.equal(f.calls[0].origin, oldOrigin);
  await f.connect('https://custom.example.com');
  assert.equal(f.calls[1].origin, 'https://custom.example.com');
  assert.notEqual(f.calls[0].publicKey, f.calls[1].publicKey);
  assert.equal((await readdir(join(f.root, 'client'))).length, 2);
});

test('manual credentials bypass automatic enrollment and custom endpoint overrides remain exact', async t => {
  const f = await fixture(t), identity = newIdentity(fingerprint), credential = credentials(identity);
  const endpoint = 'https://custom.example.com/seo/mcp';
  const calls: Array<{ url: string; headers: Headers }> = [];
  t.mock.method(globalThis, 'fetch', async (url: URL | string, init: RequestInit) => {
    const input = JSON.parse(String(init.body));
    calls.push({ url: String(url), headers: new Headers(init.headers) });
    assert.notEqual(new URL(url).pathname, '/v1/installations');
    if (!Object.hasOwn(input, 'id')) return new Response(null, { status: 202 });
    const result = input.method === 'initialize' ? { protocolVersion: '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'synthetic', version: '1' } } : { tools: [] };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: input.id, result }), { headers: { 'content-type': 'application/json' } });
  });
  const remote = new RemoteService({ ...f.env, GEORANKER_MCP_URL: endpoint, GEORANKER_ACCESS_TOKEN: credential.accessToken, GEORANKER_INSTALLATION_ID: credential.installationId }, 'seo');
  await assert.rejects(remote.initialize(), { code: 'REMOTE_PROFILE_MISMATCH' });
  await remote.close();
  assert.ok(calls.length > 0);
  for (const call of calls) {
    assert.equal(call.url, endpoint);
    assert.equal(call.headers.get('authorization'), 'Bearer ' + credential.accessToken);
    assert.equal(call.headers.get('x-georanker-installation-id'), credential.installationId);
  }
  await assert.rejects(readdir(join(f.root, 'client')), { code: 'ENOENT' });
});
