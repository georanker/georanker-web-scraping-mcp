import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cache = mkdtempSync(join(tmpdir(), 'georanker-pack-cache-'));
let result;
try { result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], { encoding: 'utf8' }))[0]; }
finally { rmSync(cache, { recursive: true, force: true }); }
const allowedModules = new Set(['cli', 'config', 'enrollment', 'errors', 'identity', 'product', 'product-contract', 'remote', 'search-depth', 'seo-contract', 'server']);
for (const { path } of result.files) {
  const match = /^dist\/src\/([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
  assert.ok((match && allowedModules.has(match[1])) || ['package.json', 'README.md', 'metadata.json', 'docs/install.md', 'docs/privacy.md', 'docs/examples.md', 'docs/seo-reports.md'].includes(path), `Unexpected package file: ${path}`);
  if (path.endsWith('.js')) {
    const code = readFileSync(path, 'utf8');
    assert.doesNotMatch(code, /GEORANKER_HV_API_KEY|GEORANKER_SEO_API_KEY|seoapi\.georanker\.com|api\.highvolume\.georanker\.com|--issue-token|--revoke-installation|from ['"].*\/(?:accounts|admin|http-server|service|seo-service|seo-config|state|access|client|callbacks)\.js['"]/, `Private service dependency in ${path}`);
  }
}
assert.equal(JSON.parse(readFileSync('package.json', 'utf8')).private, true, 'This source release must not publish to npm');
console.log(JSON.stringify({ package: result.name, files: result.files.length, clientBoundary: 'passed', privatePackage: true }));
