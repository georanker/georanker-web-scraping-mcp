// Internal worker entry. A supervisor owns the host's stdio connection.
import { run } from './runtime.js';
run().catch((error: unknown) => {
  const value = error as { code?: unknown; message?: unknown } | undefined;
  if (['REMOTE_SCHEMA_MISMATCH', 'REMOTE_PROFILE_MISMATCH', 'REMOTE_VERSION_MISMATCH', 'CLIENT_VERSION_MISMATCH'].includes(String(value?.code)) && typeof value?.message === 'string') {
    // A bounded protocol diagnostic for the parent, never routine user-facing logs.
    process.stderr.write('GEORANKER_WORKER_ERROR ' + JSON.stringify({ code: value.code, message: value.message.slice(0, 8192) }) + '\n');
  }
  process.exitCode = 1;
});
