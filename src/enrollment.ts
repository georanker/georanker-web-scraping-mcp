import { createHash, createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { AppError } from './errors.js';
import { newIdentity, registration, type InstallationIdentity } from './identity.js';

const LEGACY_ORIGIN = 'https://grmcp.ibl.ro';
const PUBLIC_ORIGIN = 'https://mcp.georanker.com';
interface Credentials { installationId: string; accessToken: string }
interface SavedState { identity?: InstallationIdentity; credentials?: Credentials }
function valid(value: Credentials): boolean {
  return !!value && /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(value.installationId) && /^[A-Za-z0-9_-]{43}$/.test(value.accessToken);
}
function stateError(): AppError {
  return new AppError('STATE_ERROR', 'Installation state is invalid or conflicts with the saved GeoRanker identity. Restore its backup or ask the operator to reconcile it. Existing state was not replaced.');
}
function identityValue(value: unknown): InstallationIdentity {
  try {
    const identity = value as InstallationIdentity;
    if (!identity || !/^[A-Za-z0-9_-]{64}$/.test(identity.privateKey) || !/^[A-Za-z0-9_-]{59}$/.test(identity.publicKey) || !/^[a-f0-9]{64}$/.test(identity.deviceFingerprint)) throw new Error();
    const key = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ format: 'der', type: 'pkcs8' }).toString('base64url') !== identity.privateKey || createPublicKey(key).export({ format: 'der', type: 'spki' }).toString('base64url') !== identity.publicKey) throw new Error();
    return identity;
  } catch { throw stateError(); }
}
function credentialValue(value: unknown): Credentials {
  if (!valid(value as Credentials)) throw stateError();
  return value as Credentials;
}
async function saved<T>(path: string, validate: (value: unknown) => T): Promise<T | undefined> {
  try { return validate(JSON.parse(await readFile(path, 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw stateError();
  }
}
async function state(directory: string): Promise<SavedState> {
  let identity = await saved(join(directory, 'identity.json'), identityValue);
  const credentials = await saved(join(directory, 'credentials.json'), credentialValue);
  // Another launcher can publish both files between these reads. Recheck the
  // identity before treating surviving credentials as an orphaned state.
  if (credentials && !identity) identity = await saved(join(directory, 'identity.json'), identityValue);
  if (credentials && !identity) throw stateError();
  return { identity, credentials };
}
const sameIdentity = (a: InstallationIdentity, b: InstallationIdentity): boolean => a.privateKey === b.privateKey && a.publicKey === b.publicKey && a.deviceFingerprint === b.deviceFingerprint;
const sameCredentials = (a: Credentials, b: Credentials): boolean => a.installationId === b.installationId && a.accessToken === b.accessToken;
function compatible(a: SavedState, b: SavedState): void {
  if (a.identity && b.identity && !sameIdentity(a.identity, b.identity)) throw stateError();
  if (a.credentials && b.credentials && !sameCredentials(a.credentials, b.credentials)) throw stateError();
}
async function publish<T>(path: string, value: T, validate: (value: unknown) => T, equal: (a: T, b: T) => boolean): Promise<T> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
  try { await link(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  finally { await unlink(temporary); }
  const actual = await saved(path, validate);
  if (!actual || !equal(actual, value)) throw stateError();
  return actual;
}
export async function installationHeaders(url: URL, env: NodeJS.ProcessEnv): Promise<Record<string, string>> {
  const root = join(resolve(env.GEORANKER_STATE_DIR || join(homedir(), '.config', 'georanker-search-mcp')), 'client');
  const directoryFor = (origin: string) => join(root, createHash('sha256').update(origin).digest('hex'));
  const approved = url.origin === LEGACY_ORIGIN || url.origin === PUBLIC_ORIGIN;
  // Keep one namespace for both approved hosts, including older launchers that
  // still use the legacy host. Changing network origin must not change identity.
  const directory = directoryFor(approved ? LEGACY_ORIGIN : url.origin);
  const alternate = approved ? directoryFor(PUBLIC_ORIGIN) : undefined;
  let existing = await state(directory);
  let alternateState = alternate ? await state(alternate) : {};
  compatible(existing, alternateState);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const identityPath = join(directory, 'identity.json');
  let identity = existing.identity;
  if (!identity) {
    const candidate = alternateState.identity || newIdentity(env.GEORANKER_DEVICE_FINGERPRINT);
    // Fresh concurrent launches may choose different candidates. Reuse the
    // published winner, but an imported existing identity must never lose.
    const temporary = `${identityPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(candidate), { mode: 0o600, flag: 'wx' });
    try { await link(temporary, identityPath); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    finally { await unlink(temporary); }
    identity = await saved(identityPath, identityValue);
    if (!identity || (alternateState.identity && !sameIdentity(identity, alternateState.identity))) throw stateError();
  }
  // Recheck after atomic publication before enrollment or credential import.
  existing = await state(directory);
  alternateState = alternate ? await state(alternate) : {};
  compatible(existing, alternateState);
  if (!existing.identity || !sameIdentity(identity, existing.identity)) throw stateError();
  const path = join(directory, 'credentials.json');
  let credentials = existing.credentials;
  if (!credentials && alternateState.credentials) credentials = await publish(path, alternateState.credentials, credentialValue, sameCredentials);
  if (!credentials) {
    let response: Response;
    try {
      response = await fetch(new URL('/v1/installations', url), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(registration(identity, url.origin)), signal: AbortSignal.timeout(15_000) });
    } catch { throw new AppError('ENROLLMENT_FAILED', 'Cannot register this installation. Check internet access and the system clock, then launch again. No paid request was made.'); }
    if (!response.ok) throw new AppError('ENROLLMENT_FAILED', `Registration returned HTTP ${response.status}. ${response.status === 429 ? 'Pilot signup limits were reached. Try again later.' : 'Contact the pilot operator if this persists.'} No paid request was made.`);
    const text = await response.text();
    if (text.length > 4096) throw new AppError('ENROLLMENT_FAILED', 'Unexpected registration response.');
    try { credentials = credentialValue(JSON.parse(text)); }
    catch { throw new AppError('ENROLLMENT_FAILED', 'Invalid registration response.'); }
    credentials = await publish(path, credentials, credentialValue, sameCredentials);
  }
  existing = await state(directory);
  alternateState = alternate ? await state(alternate) : {};
  compatible(existing, alternateState);
  if (!existing.identity || !existing.credentials || !sameIdentity(identity, existing.identity) || !sameCredentials(credentials, existing.credentials)) throw stateError();
  return { Authorization: `Bearer ${credentials.accessToken}`, 'X-GeoRanker-Installation-Id': credentials.installationId, 'X-GeoRanker-Device-Fingerprint': identity.deviceFingerprint };
}
