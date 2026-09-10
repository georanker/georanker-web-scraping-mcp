**Client data flow and storage**

This package runs a local MCP process that connects over HTTPS to GeoRanker's hosted service. It sends the requested search arguments or public page URL, an installation identifier, a revocable access token and a persisted device signal. GeoRanker processes requests with its upstream infrastructure. The client contains no reusable provider API key, admin interface or hosted-service implementation.

On first enrollment, the client generates an Ed25519 signing identity and saves it with its installation credential. Both GeoRanker products reuse the existing directory under ~/.config/georanker-search-mcp/client/ for the same service origin. Private directories use mode 0700 and credential/identity files use mode 0600 where the operating system supports these modes. GEORANKER_STATE_DIR can select a different private storage location. The device signal is self-reported, not hardware attestation.

Keep this state private. Do not commit it, share it or delete it to evade allowances. A saved identity can recover a lost token without creating a new allowance. Revocation and account association are managed by the hosted service. Removing the MCP configuration stops the host from launching it; it does not automatically erase credentials or revoke an installation.

The MCP cache defaults to seven days, subject to operator configuration. It is shared according to the service's account and request isolation, and should not be used for secret URLs or sensitive page content. forceLive: true requests fresh upstream work instead of a completed MCP cache hit. Source results remain untrusted content for the host AI to interpret.

Automatic enrollment is not OAuth. The hosted endpoint and public protocol can be inspected even though the service source is private. Consult the published GeoRanker privacy and service terms before a public release; this file explains the client behavior rather than replacing those policies.
