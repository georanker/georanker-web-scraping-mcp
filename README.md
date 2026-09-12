**Web Scraping MCP by GeoRanker**

Public web page content as readable text or HTML for AI agents, powered by GeoRanker.

Client version 0.12.0. The client source is available on GitHub. The npm package is not published. The hosted service is managed separately by GeoRanker.

**Install once, receive updates automatically**

Build this checkout with a supported Node.js version (see package.json engines), npm and Git, run the no-query setup check, and add the stable dist/src/cli.js launcher to your AI host. Follow the [installation guide](docs/install.md) for configuration and the one-time upgrade from clients older than 0.12.0.

Each push to the public main branch runs the release workflow. After tests and clean-install checks pass, it publishes a client package with signed GitHub provenance. The launcher checks for this release at startup and every 15 minutes while running, verifies its repository, workflow and commit identity and artifact checksum, then installs locked production dependencies without lifecycle scripts. Automatic updates need Node.js and npm; Git and TypeScript builds are not required after initial installation. Your current MCP session continues running. A prepared update starts when the AI host next restarts or reconnects the MCP. No reinstall or host configuration change is needed for subsequent updates. If the release workflow or update verification fails, the installed version continues working. Use --update to prepare the latest commit immediately, or set GEORANKER_MCP_AUTO_UPDATE=0 to opt out. Updates do not create provider data jobs.

> Fetch this public page as readable text: https://example.com/. Show the source and whether the content is truncated.

**Tools**

- fetch_page
- get_fetch_result

Completed MCP results are eligible for reuse for seven days by default. Pass forceLive: true to bypass completed cache and request fresh upstream work. Pending work can be reused safely; retrieve the returned job ID instead of creating another request. Results disclose cache metadata and provider generation time when supplied.  See [examples and limits](docs/examples.md).

The client enrolls automatically and stores its own installation credentials. Both GeoRanker products share their installation/account relationship for the same service origin. No manual provider API key is required. Setup performs no data query; data calls use the configured allowance and provider credits.

Request independent tasks in parallel. The hosted service applies shared and per-installation limits and may briefly queue a call. Clients sharing an installation share its limits; the operator controls slots centrally. Keep pending job or report IDs and retrieve existing results. Cancelling a call does not guarantee that submitted work stopped. Completed-result reuse remains seven days by default.

See [client privacy and data flow](docs/privacy.md). Package source is restricted to client transport, identity, updates and tool contracts. The hosted service, provider adapter and administration are not included.

**Development**

```sh
npm ci
npm test
npm run pack:check
```

The package is UNLICENSED and marked private in package.json to prevent npm publication. GitHub source availability does not grant an open-source license. metadata.json describes the product; it is not an official MCP Registry submission.
