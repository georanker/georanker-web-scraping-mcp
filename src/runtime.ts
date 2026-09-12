import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { AppError } from './errors.js';
import { RemoteService } from './remote.js';
import { createServer, SERVER_VERSION } from './server.js';
import { CLIENT_PROFILE } from './product.js';

export async function run(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && !['--setup', '--help', '-h', '--version', '-v'].includes(args[0]))) {
    throw new AppError('CLI_ARGUMENTS', 'Unsupported argument. Use --help. This package only connects to the hosted GeoRanker service.');
  }
  if (args[0] === '--version' || args[0] === '-v') { process.stdout.write(`${SERVER_VERSION}\n`); return; }
  if (args[0] === '--help' || args[0] === '-h') {
    process.stdout.write(`GeoRanker ${CLIENT_PROFILE} MCP ${SERVER_VERSION}\n\nLaunch with no arguments from an MCP host.\n--setup: verify automatic enrollment and tool discovery without a data request.\n--version: show version.\n--update: prepare the latest signed release for the next launch.\nUpdates check automatically; set GEORANKER_MCP_AUTO_UPDATE=0 to opt out.\nOptional GEORANKER_MCP_URL and GEORANKER_STATE_DIR.\nBoth GeoRanker products share the existing installation identity for the same service origin.\n`);
    return;
  }
  const service = new RemoteService({ ...process.env }, CLIENT_PROFILE);
  try {
    await service.initialize();
    if (args[0] === '--setup') {
      process.stdout.write(`GeoRanker ${CLIENT_PROFILE} MCP is connected. No data query was submitted.\n`);
      await service.close();
      return;
    }
    const server = createServer(service, CLIENT_PROFILE);
    server.server.onclose = () => { void service.close().catch(() => {}); };
    await server.connect(new StdioServerTransport());
  } catch (error) {
    await service.close().catch(() => {});
    throw error;
  }
}

