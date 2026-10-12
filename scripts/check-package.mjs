import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cache = mkdtempSync(join(tmpdir(), 'georanker-pack-cache-'));
let result;
try { result = JSON.parse(execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts', '--cache', cache], { encoding: 'utf8' }))[0]; }
finally { rmSync(cache, { recursive: true, force: true }); }
const allowedModules = new Set(['cli', 'config', 'enrollment', 'errors', 'identity', 'product', 'product-contract', 'remote', 'runtime', 'supervisor', 'worker', 'updater', 'search-depth', 'seo-contract', 'whois-contract', 'server']);
for (const { path } of result.files) {
  const match = /^dist\/src\/([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
  assert.ok((match && allowedModules.has(match[1])) || ['package.json', 'npm-shrinkwrap.json', 'LICENSE', 'README.md', 'metadata.json', 'docs/install.md', 'docs/privacy.md', 'docs/examples.md', 'docs/seo-reports.md', 'docs/whois.md'].includes(path), `Unexpected package file: ${path}`);
  if (path.endsWith('.js')) {
    const code = readFileSync(path, 'utf8');
    assert.doesNotMatch(code, /GEORANKER_HV_API_KEY|GEORANKER_SEO_API_KEY|seoapi\.georanker\.com|api\.highvolume\.georanker\.com|--issue-token|--revoke-installation|from ['"].*\/(?:accounts|admin|http-server|service|seo-service|seo-config|state|access|client|callbacks)\.js['"]/, `Private service dependency in ${path}`);
  }
}
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
assert.equal(pkg.license, 'MIT');
assert.ok(result.files.some(file => file.path === 'LICENSE'), 'MIT notice must be distributed.');
assert.ok(result.files.some(file => file.path === 'npm-shrinkwrap.json'), 'Locked runtime dependencies must be distributed.');
assert.ok(result.files.some(file => file.path === 'dist/src/cli.js'), 'Compiled CLI must be distributed.');
assert.match(readFileSync('dist/src/cli.js', 'utf8'), /^#!\/usr\/bin\/env node\n/);
const publicRepository = /^git\+https:\/\/github\.com\/georanker\/georanker-(?:seo|web-scraping)-mcp\.git$/.test(pkg.repository.url);
assert.equal(pkg.private, !publicRepository, 'Only reviewed public client exports may publish to npm.');
if (publicRepository) assert.equal(pkg.publishConfig?.access, 'public');
console.log(JSON.stringify({ package: result.name, files: result.files.length, clientBoundary: 'passed', license: pkg.license, npmPublishable: publicRepository }));
