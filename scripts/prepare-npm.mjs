// Include the reviewed dependency lock in the public npm distribution.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
const bytes = await readFile(resolve(root, 'package-lock.json'));
const lock = JSON.parse(bytes.toString('utf8'));
assert.ok(['@georanker/seo-mcp', '@georanker/web-scraping-mcp'].includes(pkg.name));
assert.equal(pkg.license, 'MIT');
assert.equal(lock.lockfileVersion, 3);
assert.equal(lock.name, pkg.name);
assert.equal(lock.version, pkg.version);
assert.equal(lock.packages?.['']?.name, pkg.name);
assert.equal(lock.packages?.['']?.version, pkg.version);
assert.equal(lock.packages?.['']?.license, 'MIT');
assert.deepEqual(lock.packages[''].dependencies, pkg.dependencies);
assert.match(await readFile(resolve(root, 'LICENSE'), 'utf8'), /^MIT License\n/);
await writeFile(resolve(root, 'npm-shrinkwrap.json'), bytes);
