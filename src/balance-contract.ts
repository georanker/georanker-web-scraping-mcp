/** Public balance discovery contract shared by both MCP clients. */
export const BALANCE_TOOL = 'get_balance';
export const BALANCE_HEADER = 'X-GeoRanker-Balance-Tools';
export const BALANCE_CATALOG = 'balance-v1';
export const BALANCE_GUIDANCE = 'Report the returned balance with the result: remaining MCP allowance and provider credit freshness. MCP admission units are separate from provider credits. Do not call get_balance again when the response already includes balance.';
