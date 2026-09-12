// Package only the reviewed compiled client and its locked runtime dependencies.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 2 && args[0] === '--output'), 'Usage: prepare-release.mjs [--output DIRECTORY]');
const output = resolve(args[1] || join(root, 'release'));
const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
assert.ok(['@georanker/seo-mcp', '@georanker/web-scraping-mcp'].includes(packageJson.name), 'Only a split GeoRanker client can be packaged.');
assert.match(packageJson.version, /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const lockBytes = await readFile(join(root, 'package-lock.json'));
const lock = JSON.parse(lockBytes.toString('utf8'));
assert.equal(lock.lockfileVersion, 3, 'A reviewed npm v3 lockfile is required.');
assert.equal(lock.name, packageJson.name);
assert.equal(lock.version, packageJson.version);
assert.equal(lock.packages?.['']?.name, packageJson.name);
assert.equal(lock.packages?.['']?.version, packageJson.version);
assert.deepEqual(lock.packages[''].dependencies, packageJson.dependencies, 'Runtime dependencies must match the lockfile.');

const modules = new Set([
  'cli', 'config', 'enrollment', 'errors', 'identity', 'product', 'product-contract',
  'remote', 'runtime', 'search-depth', 'seo-contract', 'server', 'updater',
]);
const allowedPath = path => {
  if (['package.json', 'npm-shrinkwrap.json'].includes(path)) return true;
  const match = /^dist\/src\/([a-z-]+)\.(?:js|d\.ts)$/.exec(path);
  return Boolean(match && modules.has(match[1]));
};
const exists = async path => {
  try { await access(path, constants.F_OK); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const work = await mkdtemp(join(tmpdir(), 'georanker-client-release-'));
const stage = join(work, 'package');
const clean = join(work, 'clean');
const env = { ...process.env, PATH: dirname(process.execPath) + ':' + (process.env.PATH || ''), GEORANKER_MCP_AUTO_UPDATE: '0' };
const command = (program, commandArgs, cwd) => execFileSync(program, commandArgs, {
  cwd, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
  stdio: ['ignore', 'pipe', 'pipe'],
});

try {
  await mkdir(join(stage, 'dist', 'src'), { recursive: true });
  const compiled = await readdir(join(root, 'dist', 'src'));
  for (const name of compiled) {
    const relative = 'dist/src/' + name;
    assert.ok(allowedPath(relative), 'Unexpected compiled client file: ' + relative);
    const source = join(root, relative);
    assert.ok((await lstat(source)).isFile(), 'Compiled client entries must be regular files.');
    if (name.endsWith('.js')) {
      const code = await readFile(source, 'utf8');
      assert.doesNotMatch(code, /GEORANKER_HV_API_KEY|GEORANKER_SEO_API_KEY|seoapi\.georanker\.com|api\.highvolume\.georanker\.com|--issue-token|--revoke-installation|from ['"].*\/(?:accounts|admin|http-server|service|seo-service|seo-config|state|access|client|callbacks)\.js['"]/, 'Private service dependency in ' + relative);
    }
    await copyFile(source, join(stage, relative));
  }
  for (const module of modules) {
    assert.ok(compiled.includes(module + '.js'), 'Missing runtime module: ' + module);
  }

  const runtimePackage = {
    name: packageJson.name,
    version: packageJson.version,
    private: true,
    license: packageJson.license,
    type: 'module',
    description: packageJson.description,
    repository: packageJson.repository,
    engines: packageJson.engines,
    bin: packageJson.bin,
    files: ['dist/src', 'npm-shrinkwrap.json'],
    dependencies: packageJson.dependencies,
  };
  await writeFile(join(stage, 'package.json'), JSON.stringify(runtimePackage, null, 2) + '\n');
  await writeFile(join(stage, 'npm-shrinkwrap.json'), lockBytes);

  const packed = JSON.parse(command('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', work], stage));
  assert.equal(packed.length, 1);
  const artifact = join(work, packed[0].filename);
  for (const { path } of packed[0].files) assert.ok(allowedPath(path), 'Unexpected package file: ' + path);
  assert.ok(packed[0].files.some(file => file.path === 'npm-shrinkwrap.json'), 'The distributable must contain its dependency lock.');
  const entries = command('tar', ['-tzf', artifact], work).trim().split('\n');
  assert.ok(entries.length > 2);
  for (const entry of entries) {
    assert.ok(entry.startsWith('package/') && allowedPath(entry.slice(8)), 'Unexpected archive entry: ' + entry);
  }

  await mkdir(clean);
  command('tar', ['-xzf', artifact, '-C', clean], work);
  const installed = join(clean, 'package');
  command('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], installed);
  for (const [path, info] of Object.entries(lock.packages)) {
    if (info.dev !== true) continue;
    assert.ok(path.startsWith('node_modules/') && !path.split('/').includes('..'), 'Invalid locked development path.');
    assert.equal(await exists(join(installed, path)), false, 'Development dependency present in the runtime: ' + path);
  }
  const isolatedState = join(work, 'unused-client-state');
  const version = execFileSync(process.execPath, [join(installed, 'dist/src/cli.js'), '--version'], {
    cwd: installed, env: { ...env, GEORANKER_STATE_DIR: isolatedState }, encoding: 'utf8',
    timeout: 15_000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  assert.equal(version, packageJson.version, 'The clean-installed client must report the release version.');
  assert.equal(await exists(isolatedState), false, 'The version check must not create enrollment state.');

  await mkdir(output, { recursive: true });
  const temporary = join(output, '.client-update-' + process.pid + '.tgz');
  await copyFile(artifact, temporary);
  await rename(temporary, join(output, 'client-update.tgz'));
  process.stdout.write(JSON.stringify({
    artifact: join(output, 'client-update.tgz'),
    package: packageJson.name,
    version: packageJson.version,
    files: packed[0].files.length,
    cleanInstall: 'passed',
  }) + '\n');
} finally {
  await rm(work, { recursive: true, force: true });
}
