import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError } from './errors.js';
import { newIdentity, registration, type InstallationIdentity } from './identity.js';

interface Credentials { installationId: string; accessToken: string }
function valid(value: Credentials): boolean {
  return !!value && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.installationId) && /^[A-Za-z0-9_-]{43}$/.test(value.accessToken);
}
export async function installationHeaders(url: URL, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const directory = join(resolve(env.GEORANKER_STATE_DIR || join(homedir(), '.config', 'georanker-search-mcp')), 'client', createHash('sha256').update(url.origin).digest('hex'));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identityPath = join(directory, 'identity.json');
  let identity: InstallationIdentity;
  try { identity = JSON.parse(await readFile(identityPath, 'utf8')) as InstallationIdentity; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('STATE_ERROR', 'Cannot read the saved installation identity. Restore its backup; it was not replaced.');
    // Link a completely written file without overwriting another launch's identity.
    const temporary = `${identityPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(newIdentity(env.GEORANKER_DEVICE_FINGERPRINT)), { mode: 0o600, flag: 'wx' });
    try { await link(temporary, identityPath); }
    catch (linkError) { if ((linkError as NodeJS.ErrnoException).code !== 'EEXIST') throw linkError; }
    finally { await unlink(temporary); }
    identity = JSON.parse(await readFile(identityPath, 'utf8')) as InstallationIdentity;
  }
  const path = join(directory, 'credentials.json');
  let credentials: Credentials;
  try {
    credentials = JSON.parse(await readFile(path, 'utf8')) as Credentials;
    if (!valid(credentials)) throw new Error();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new AppError('STATE_ERROR', 'Cannot read saved installation credentials. They were not replaced.');
    let response: Response;
    try {
      response = await fetch(new URL('/v1/installations', url), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration(identity, url.origin)), signal: AbortSignal.timeout(15_000) });
    } catch { throw new AppError('ENROLLMENT_FAILED', 'Cannot register this installation. Check internet access and the system clock, then launch again. No paid request was made.'); }
    if (!response.ok) throw new AppError('ENROLLMENT_FAILED', `Registration returned HTTP ${response.status}. ${response.status === 429 ? 'Pilot signup limits were reached. Try again later.' : 'Contact the pilot operator if this persists.'} No paid request was made.`);
    const text = await response.text();
    if (text.length > 4096) throw new AppError('ENROLLMENT_FAILED', 'Unexpected registration response.');
    credentials = JSON.parse(text) as Credentials;
    if (!valid(credentials)) throw new AppError('ENROLLMENT_FAILED', 'Invalid registration response.');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(credentials), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  if (!/^[a-f0-9]{64}$/.test(identity.deviceFingerprint)) throw new AppError('STATE_ERROR', 'Invalid saved device identity.');
  return { Authorization: `Bearer ${credentials.accessToken}`, 'X-GeoRanker-Installation-Id': credentials.installationId, 'X-GeoRanker-Device-Fingerprint': identity.deviceFingerprint };
}
