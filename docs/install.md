**Install Web Scraping MCP by GeoRanker**

The client source is public. The npm package is not published. Build once with Node.js 22+:

```sh
git clone https://github.com/georanker/georanker-web-scraping-mcp.git
cd georanker-web-scraping-mcp
npm ci
npm run build
node dist/src/cli.js --setup
```

The setup check verifies enrollment and the expected tools without a data query. The matching hosted profile is deployed, and authenticated product tool discovery has been verified. Set GEORANKER_MCP_URL only when using a different endpoint. An unavailable or mismatched endpoint must be fixed by the operator; do not delete installation state to retry. This connection check is separate from first-result quality and individual host/OS certification.

For the host examples below, replace /ABSOLUTE/PATH/client.js with the absolute path to this checkout's dist/src/cli.js. On systems where the graphical application cannot find Node, set command to the absolute node executable path. Preserve unrelated configuration entries. Reconnect the host after changes, enable/trust the tools when requested, then run the sample prompt.

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

Future public package configuration, after publication, can replace command node /ABSOLUTE/PATH/client.js with npx -y @georanker/web-scraping-mcp@VERSION. That command is not an available registry install today. Keep release versions explicit.

Host configuration formats above are documented compatibility routes. Local protocol fixtures do not prove each host or operating system has been exercised. Cloud-only connections require a separately tested remote authentication path; do not assume the current endpoint URL is sufficient.
