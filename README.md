**Web Scraping MCP by GeoRanker**

Public web page content as readable text or HTML for AI agents, powered by GeoRanker.

Public client source, version 0.10.2. Install from this repository; the npm package is not published. The hosted service is managed separately by GeoRanker. Setup checks the connection without submitting a data query. Availability and completion of individual reports depend on the hosted service.

**Start with one useful result**

Build this client with Node.js 22+, run the no-query setup check, and add it to your AI host. Follow the [installation guide](docs/install.md) for Codex, Claude Code, Claude Desktop, Cursor, VS Code, Windsurf, Cline, Continue, Gemini CLI, OpenCode and OMP.

> Fetch this public page as readable text: https://example.com/. Show the source and whether the content is truncated.

**Tools**

- fetch_page
- get_fetch_result

Completed MCP results are eligible for reuse for seven days by default. Pass forceLive: true to bypass completed cache and request fresh upstream work. Pending work can be reused safely; retrieve the returned job ID instead of creating another request. Results disclose cache metadata and provider generation time when supplied.  See [examples and limits](docs/examples.md).

The client enrolls automatically and stores its own installation credentials. Both GeoRanker products share their installation/account relationship for the same service origin. No manual provider API key is required. Setup performs no data query; data calls use the configured allowance and provider credits. Public upgrade availability and limits must match the hosted service's actual state.

Request independent tasks in parallel. The hosted service applies shared and per-installation limits and may briefly queue a call. Clients sharing an installation share its limits; the operator controls slots centrally. Keep pending job or report IDs and retrieve existing results. Cancelling a call does not guarantee that submitted work stopped. Completed-result reuse remains seven days by default.

See [client privacy and data flow](docs/privacy.md). Host instructions are based on official configuration documentation; fixture tests are not live-provider or all-host certification. Package source is restricted to public-safe client transport, identity and tool contracts. The hosted service, provider adapter and administration are not included.

**Development**

```sh
npm ci
npm test
npm run pack:check
```

The existing UNLICENSED designation is retained; this publication does not add an open-source license. The private flag in package.json prevents accidental npm publication and does not control GitHub visibility. metadata.json describes the client and is not a submitted official-registry manifest.
