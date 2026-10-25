**Web Scraping MCP by GeoRanker: first workflow**

Fetch this public page as readable text: https://example.com/. Show the source and whether the content is truncated.

Call fetch_page with this input to request live fetching:

```json
{
  "url": "https://example.com/",
  "format": "text",
  "forceLive": true
}
```

Omit forceLive or set it to false to allow seven-day completed-cache reuse. Live fetching bypasses the MCP cache, not the provider's own processing rules. If pending, call get_fetch_result with the same jobId. Lookups never start another data job.

Ordinary output is readable text or HTML capped at 50,000 characters, with no automatic linked CSS or JavaScript downloads. Opt in with fullContent: true to read the saved result in UTF-8 chunks (default 50000 bytes, maximum maxBytes: 100000). Use nextCursor with get_fetch_result and the same jobId until hasMore is false. Chunks do not create another scrape or spend query admission units. sourceTruncated distinguishes an incomplete provider capture from response pagination. To fetch exactly one asset, explicitly pass resourceType: "css" or "javascript" with its public HTTPS URL. Each fresh asset uses normal MCP allowance, follows at most three validated redirects, and is limited to 8 MiB of UTF-8 source with a matching content type. Assets are never executed or fetched recursively. HTML preserves inline styles and scripts; readable text omits them. fullContent also lists references found in saved markup without downloading them. download: true explicitly prepares a saved-file download, available for up to 24 hours subject to storage limits, using the same MCP authentication and ownership checks. It returns an authenticated GET URL, bytes and SHA-256. Downloads do not start another scrape. No public or anonymous file links are issued. A provider capture may already be capped (currently 2 MiB for rendered HTML), so complete means all available saved content, not a guarantee of an unlimited original page. Pending responses require repeating the requested content/download options with the same job ID. Older clients keep their original schemas and output limits; use the current client or refresh native connector tools for the optional parameters.

Display cached, cachedAt and generatedAt when available. A missing provider generation timestamp must not be invented. The default does not mean background refresh every seven days.

Request independent tasks in parallel. The hosted service applies shared and per-installation limits and may briefly queue a call. Clients sharing an installation share its limits; the operator controls slots centrally. Keep pending job or report IDs and retrieve existing results. Cancelling a call does not guarantee that submitted work stopped. Completed-result reuse remains seven days by default.
