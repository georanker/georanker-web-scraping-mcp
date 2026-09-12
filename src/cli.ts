#!/usr/bin/env node
// Keep the configured entry point stable; verified releases also update this launcher.
import { realpathSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { CLIENT_PROFILE, CLIENT_REPOSITORY, CLIENT_VERSION } from './product.js';
import { checkForUpdate, selectRelease, rollbackRelease, type UpdateOptions } from './updater.js';

const args = process.argv.slice(2);
const supported = ['--setup', '--help', '-h', '--version', '-v', '--update'];
const options: UpdateOptions = {
  repository: CLIENT_REPOSITORY, version: CLIENT_VERSION,
  bundledRoot: resolve(dirname(fileURLToPath(import.meta.url)), '../..'),
  env: process.env,
  log: message => process.stderr.write('GeoRanker ' + CLIENT_PROFILE + ' MCP: ' + message + '\n'),
};

async function runBundled(): Promise<void> {
  if (args[0] === '--update') {
    const result = await checkForUpdate({ ...options, force: true });
    process.stdout.write(JSON.stringify(result) + '\n');
    if (result.status === 'failed') process.exitCode = 1;
    return;
  }
  if (args.length === 0) {
    const { createSupervisor } = await import('./supervisor.js');
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    const supervisor = await createSupervisor(options);
    try { await supervisor.connect(new StdioServerTransport()); }
    catch (error) { await supervisor.close(); throw error; }
    return;
  }
  const runtime = await import(pathToFileURL(resolve(options.bundledRoot, 'dist/src/runtime.js')).href);
  await runtime.run();
}

async function runRelease(root: string): Promise<void> {
  if (root === options.bundledRoot) return runBundled();
  const client = await import(pathToFileURL(resolve(root, 'dist/src/cli.js')).href);
  if (typeof client.launch !== 'function') throw new Error('Prepared client does not export its launcher.');
  // The selected release owns its runtime AND future update checks. Avoid recursion.
  await client.launch(true);
}

// This export is the stable delegation contract for already-installed launchers.
// bundledOnly is used only by a parent launcher after it selects a verified release.
export async function launch(bundledOnly = false): Promise<void> {
  if (args.length > 1 || (args.length === 1 && !supported.includes(args[0]))) {
    throw Object.assign(new Error('Unsupported argument. Use --help. This package only connects to the hosted GeoRanker service.'), { code: 'CLI_ARGUMENTS' });
  }
  if (bundledOnly) return runBundled();

  const attempted = new Set<string>();
  let failure: unknown;
  // Initialization may fall back through current, previous and bundled releases.
  // runtime.run rejects only before a usable stdio connection is established.
  for (let attempt = 0; attempt < 3; attempt++) {
    const release = await selectRelease(options);
    if (attempted.has(release.root)) break;
    attempted.add(release.root);
    try { await runRelease(release.root); return; }
    catch (error) {
      failure = error;
      if (!release.commit) break;
      options.log?.('The prepared client could not start. Trying the previous working client.');
      await rollbackRelease(options, release.commit);
    }
  }
  // A read-only or damaged pointer must not prevent use of the bundled client.
  if (!attempted.has(options.bundledRoot)) {
    attempted.add(options.bundledRoot);
    try { await runBundled(); return; }
    catch (error) { failure = error; }
  }

  // Older tool schemas can fail initialization before periodic updates start.
  // Check once here, before accepting requests, so a verified compatible update can heal it.
  if (options.env.GEORANKER_MCP_AUTO_UPDATE !== '0' && (args.length === 0 || args[0] === '--setup')) {
    options.log?.('Client initialization failed. Checking for a signed compatible update.');
    await checkForUpdate(options);
    const updated = await selectRelease(options);
    if (updated.commit && !attempted.has(updated.root)) {
      try { await runRelease(updated.root); return; }
      catch (error) {
        failure = error;
        await rollbackRelease(options, updated.commit);
      }
    }
  }
  throw failure;
}

function isEntryPoint(): boolean {
  if (!process.argv[1]) return false;
  const entry = resolve(process.argv[1]);
  if (pathToFileURL(entry).href === import.meta.url) return true;
  try { return pathToFileURL(realpathSync(entry)).href === import.meta.url; }
  catch { return false; }
}

if (isEntryPoint()) {
  launch().catch((error: unknown) => {
    const diagnostic = error as { code?: unknown; message?: unknown } | undefined;
    const message = typeof diagnostic?.code === 'string' && typeof diagnostic?.message === 'string'
      ? diagnostic.code + ': ' + diagnostic.message : 'The connection could not be started.';
    process.stderr.write('GeoRanker ' + CLIENT_PROFILE + ' MCP: ' + message + '\n');
    process.exitCode = 1;
  });
}
