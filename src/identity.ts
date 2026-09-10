import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { arch, cpus, hostname, platform } from 'node:os';
import { AppError } from './errors.js';

export function deviceFingerprint(): string {
  // Supporting, self-reported signal only. This is not hardware attestation.
  return createHash('sha256').update(JSON.stringify({ hostname: hostname(), platform: platform(), arch: arch(), cpu: cpus()[0]?.model || '' })).digest('hex');
}
export interface InstallationIdentity { privateKey: string; publicKey: string; deviceFingerprint: string }
export interface Registration { publicKey: string; deviceFingerprint: string; timestamp: number; nonce: string; signature: string }
export function newIdentity(fingerprint = deviceFingerprint()): InstallationIdentity {
  if (!/^[a-f0-9]{64}$/.test(fingerprint)) throw new AppError('CONFIG_ERROR', 'Device fingerprint must be a lowercase SHA-256 hex string.');
  const pair = generateKeyPairSync('ed25519');
  return { privateKey: pair.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64url'), publicKey: pair.publicKey.export({ format: 'der', type: 'spki' }).toString('base64url'), deviceFingerprint: fingerprint };
}
function message(input: Omit<Registration, 'signature'>, origin: string): Buffer {
  return Buffer.from(JSON.stringify(['georanker-installation-v1', origin, input.publicKey, input.deviceFingerprint, input.timestamp, input.nonce]));
}
export function registration(identity: InstallationIdentity, origin: string): Registration {
  const input = { publicKey: identity.publicKey, deviceFingerprint: identity.deviceFingerprint, timestamp: Date.now(), nonce: randomBytes(24).toString('base64url') };
  const key = createPrivateKey({ key: Buffer.from(identity.privateKey, 'base64url'), format: 'der', type: 'pkcs8' });
  return { ...input, signature: sign(null, message(input, origin), key).toString('base64url') };
}
