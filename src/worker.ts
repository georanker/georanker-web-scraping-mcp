// Internal worker entry. A supervisor owns the host's stdio connection.
import { run } from './runtime.js';
run().catch(() => {
  // The supervisor reports startup failure without forwarding worker diagnostics.
  process.exitCode = 1;
});
