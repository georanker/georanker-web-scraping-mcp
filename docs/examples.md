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

Output is readable text or HTML, capped at 50,000 characters with truncation disclosed. Structured field extraction, browser-rendering guarantees and batch crawling are not features of this release. The provider can return pending work; use the returned job ID to retrieve its result.

Display cached, cachedAt and generatedAt when available. A missing provider generation timestamp must not be invented. The default does not mean background refresh every seven days.

Request independent tasks in parallel. The hosted service applies shared and per-installation limits and may briefly queue a call. Clients sharing an installation share its limits; the operator controls slots centrally. Keep pending job or report IDs and retrieve existing results. Cancelling a call does not guarantee that submitted work stopped. Completed-result reuse remains seven days by default.
