import { AppError } from './errors.js';

// Client URL validation only. Upstream API and operator configuration stay private.
export function secureUrl(value: string, name: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError('CONFIG_ERROR', `${name} must be a valid URL.`); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) {
    throw new AppError('CONFIG_ERROR', `${name} requires HTTPS without credentials, query parameters, or fragments. HTTP is allowed only on loopback.`);
  }
  return url;
}
