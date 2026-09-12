**Install Web Scraping MCP by GeoRanker**

The client source is available on GitHub. The npm package is not published. Build once with npm, Git and a Node.js version supported by package.json: 22.22.2+ on the 22 release line, 24.15.0+ on the 24 release line, or 26.0.0+.

```sh
git clone https://github.com/georanker/georanker-web-scraping-mcp.git georanker-web-scraping-mcp
cd georanker-web-scraping-mcp
npm ci
npm run build
node dist/src/cli.js --setup
```

The setup check verifies enrollment and the expected tools without a data query. Set GEORANKER_MCP_URL only when using a different endpoint. An unavailable or mismatched endpoint must be fixed by the operator; do not delete installation state to retry.

For the host examples below, replace /ABSOLUTE/PATH/client.js with the absolute path to this checkout's dist/src/cli.js. On systems where the graphical application cannot find Node, set command to the absolute node executable path. Preserve unrelated configuration entries. Reconnect the host after changes, enable/trust the tools when requested, then run the sample prompt.

**Automatic updates**

Keep your host configured to the same dist/src/cli.js launcher. Starting with client 0.13.0, it checks for released updates from the public georanker/georanker-web-scraping-mcp repository at startup and every five minutes while the MCP is running. A push to main automatically runs the repository's release workflow. Only after its tests and clean-install checks pass does that workflow publish the client package with signed GitHub provenance.

The launcher verifies the package's signed provenance against the expected public repository, main-branch release workflow and commit, then checks its artifact checksum. It prepares the verified package in a separate cache and installs its locked production dependencies without lifecycle scripts. It does not download and execute an unverified branch checkout. A stable supervisor keeps the host MCP connection open and runs tools through an internal worker. A verified candidate replaces the worker when no tool calls are active and 60 seconds have passed without tool activity. This idle period concerns the MCP connection, not the whole AI host or existing provider jobs. Calls are never replayed as part of a swap. If the candidate fails, the current worker continues. The prepared version is also available on later launches when GitHub is unavailable.

Updates require a supported Node.js version and npm on the MCP process's PATH, access to GitHub, the npm registry and the signature verification service, and write access to the update cache. Git and a TypeScript build are only needed for the initial source installation, not for automatic updates. The default cache is ~/.config/georanker-mcp-updates/georanker-web-scraping-mcp. Set GEORANKER_MCP_UPDATE_DIR to choose another cache root. This is separate from your existing identity and credentials, which are preserved.

To prepare the latest commit immediately:

```sh
node dist/src/cli.js --update
```

A running 0.13.0+ supervisor applies a prepared compatible worker during the next idle period. After a cancelled or timed-out worker request, automatic worker swaps wait for a normal host reconnect because completion is uncertain. Changes to supervisor code itself take effect on a normal host restart or MCP reconnect. Set GEORANKER_MCP_AUTO_UPDATE=0 in the host's MCP environment to disable automatic updates. A failed release workflow, download, signature verification or setup check leaves the available client version in place. Automatic checks are quiet when no update is available or a check cannot complete. An applied update is reported on stderr, separate from the MCP protocol.

**Migration for existing installations**

Existing 0.12.0 installations prepare 0.13.0 automatically and load its supervisor on the next host restart or MCP reconnect. After that one reconnect, compatible worker updates apply inside the session during idle periods. Future changes to the supervisor itself still require a normal restart.

Clients older than 0.12.0 cannot update themselves. From a clean checkout of the public repository, run this once:

```sh
git pull --ff-only
npm ci
npm run build
node dist/src/cli.js --setup
```

Then restart or reconnect the MCP in your host. Keep the existing launcher path and credentials. Subsequent compatible worker updates that pass the public main release workflow are prepared and applied during idle periods, without another reinstall.

**Codex**

```sh
codex mcp add georanker-web-scraping -- node /ABSOLUTE/PATH/client.js
```

Use /mcp to inspect the connection. [Official guide](https://developers.openai.com/codex/mcp).

**Claude Code**

```sh
claude mcp add --scope user --transport stdio georanker-web-scraping -- node /ABSOLUTE/PATH/client.js
```

Use /mcp to inspect the connection. [Official guide](https://code.claude.com/docs/en/mcp).

**Hosts using an mcpServers object**

```json
{
  "mcpServers": {
    "georanker-web-scraping": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/client.js"]
    }
  }
}
```

| Host | Where to add the entry | Extra step |
| --- | --- | --- |
| [Claude Desktop](https://claude.com/docs/connectors/building/mcpb) | Developer MCP configuration opened through application settings | Restart/reconnect; a tested .mcpb installer is planned, not supplied in this release |
| [Cursor](https://prod.cursor.com/docs/mcp) | ~/.cursor/mcp.json or project .cursor/mcp.json | Add type: stdio to the server entry; enable it |
| [Windsurf](https://docs.windsurf.com/windsurf/cascade/mcp) | Cascade MCP configuration, normally ~/.codeium/windsurf/mcp_config.json | Verify the current app/version path, then refresh tools |
| [Cline](https://docs.cline.bot/mcp/mcp-overview) | MCP Servers > Configure > Configure MCP Servers | Save and reconnect |
| [Continue](https://docs.continue.dev/customize/deep-dives/mcp) | .continue/mcpServers/mcp.json | Use Agent mode |
| [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/) | Merge into ~/.gemini/settings.json | Inspect /mcp; user scope shown |
| [OMP / Oh My Pi](https://github.com/can1357/oh-my-pi/blob/main/docs/mcp-config.md) | ~/.omp/agent/mcp.json or project .omp/mcp.json | Add type: stdio; inspect /mcp and avoid duplicate imported entries |

**VS Code / GitHub Copilot**

Use “MCP: Add Server,” or .vscode/mcp.json with a servers object:

```json
{
  "servers": {
    "georanker-web-scraping": {
      "type": "stdio",
      "command": "node",
      "args": ["/ABSOLUTE/PATH/client.js"]
    }
  }
}
```

Start/trust the server and enable its tools. [Official guide](https://code.visualstudio.com/docs/agent-customization/mcp-servers).

**OpenCode**

Merge into opencode.json:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "georanker-web-scraping": {
      "type": "local",
      "command": ["node", "/ABSOLUTE/PATH/client.js"],
      "enabled": true
    }
  }
}
```

Run --setup before adding the entry to avoid first-enrollment work during the host's short discovery timeout. [Official guide](https://opencode.ai/docs/mcp-servers/).

**First prompt**

> Fetch this public page as readable text: https://example.com/. Show the source and whether the content is truncated.

By default, eligible completed data can be reused for up to seven days. Add “Force a live fetch” to request forceLive: true. That bypasses the MCP's completed cache; pending work can be reused and should be retrieved using get_fetch_result. It does not schedule automatic refreshes or guarantee instant completion.

The npm package is unpublished. Use the GitHub installation and stable launcher above; npx is not an available installation method for this release.

Host configuration formats above are documented compatibility routes. Local protocol fixtures do not prove each host or operating system has been exercised. Cloud-only connections require a separately tested remote authentication path; do not assume the current endpoint URL is sufficient.
