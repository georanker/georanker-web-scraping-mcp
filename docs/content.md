# Optional full content and asset source

Ordinary `fetch_page` and `get_fetch_result` requests keep the existing text/HTML behavior and 50,000-character output cap. They do not fetch external CSS or JavaScript, enumerate asset references, or prepare additional downloadable files. Every new control is optional.

Read an existing saved page without creating another scrape:

```json
{"jobId":"YOUR_JOB_ID","format":"html","fullContent":true,"maxBytes":100000}
```

The same options work on an initial `fetch_page` call. The output includes `totalBytes`, `returnedBytes`, `offsetBytes`, SHA-256, `hasMore`, and `nextCursor`. Repeat `get_fetch_result` with the same job ID and `cursor` until `hasMore` is false. Omit `format` to inherit the cursor's format. Default chunks are 50,000 UTF-8 bytes; `maxBytes` accepts 1,024 to 100,000. A cursor cannot switch owners, jobs, formats, or saved snapshots. Later chunks read saved data and consume no query admission units, while ordinary HTTP/read rate limits still apply.

HTML includes inline CSS and JavaScript. Readable text excludes script/style content. The first optional full-content response lists at most 128 static CSS/JS references (up to 16,000 URL characters) from saved HTML, without downloading them. Relative URLs use the requested page URL because the final page URL is not verified. HTML base overrides are not inferred. Review the desired URL before requesting it.

Fetch one named asset explicitly:

```json
{"url":"https://example.com/site.css","resourceType":"css","fullContent":true}
```

Use `resourceType: "javascript"` for JavaScript. The default is `page`. Asset mode fetches one public HTTPS URL, returns raw UTF-8 source, never executes it, never sends browser cookies or provider credentials, and never follows imports or fetches additional linked files. It validates and pins public DNS answers on every hop, allows at most three redirects, and requires a matching CSS/JS content type. HTML challenge pages, private addresses, compression and non-UTF-8 data are rejected. Assets are limited to 8 MiB and use a separate two-slot scheduler. A fresh asset request uses the same shared MCP/user query allowances as page scraping. Result reads and downloads do not create another fetch. An expired/missing saved asset returns an explicit error, with no silent redownload. Use an explicit `forceLive: true` request if another fetch is desired.

Add `download: true` only when a saved file is needed. It returns `download.path`, an authenticated GET URL, with bytes, SHA-256, filename, expiry, and `complete`. Use the same bearer credential, installation and device headers as the MCP request. OAuth uses the same product audience and user. This is a programmatic download, and a browser without authentication returns 401. Do not put tokens in the URL or share credentials. Files are returned as attachments with no-store, nosniff and a sandbox content policy. A job ownership grant is required before opening a file. File requests use HTTP/read throttles, without query admission or provider work.

The opt-in private spool retains at most 64 files and 128 MiB, for up to 24 hours. Oldest or expired files are evicted when saving another file; retrieval may expire sooner under storage pressure. Ordinary page requests never write this spool. Asset mode inherently downloads and stores the explicitly requested source once. Page download files are created only by `download: true`.

`sourceTruncated` is separate from chunk pagination. `hasMore` describes remaining saved bytes. `sourceTruncated` means the provider capture or text conversion already reached a limit. Rendered HTML remains capped at 2 MiB. Downloading an incomplete capture sets `complete: false` and uses a `-partial` filename. Full content means all available saved content, not an unlimited provider response. Challenge/access-denied classifications remain failed even when their evidence is retrieved in full.

If submission is pending, retain the job ID and repeat the desired optional controls on retrieval. No defaults are upgraded silently. Native OAuth connections receive the optional tool schema after a catalog refresh. Updated clients negotiate `X-GeoRanker-Content-Tools: content-v1`; clients without this header keep their original schemas, preserving strict schema validation and defaults.
