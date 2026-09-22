/**
 * Shared numeric limits, deadlines, and protocol constants for the MCP feature.
 *
 * Every value here is a deliberate budget: the reader sizes bound how much a
 * hostile or broken endpoint can make this process allocate, and the timings
 * bound how often a failing server gets retried.
 */

/** Largest response body accepted from a remote MCP endpoint. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

/** Largest JSON body the settings routes accept from the browser. */
export const MAX_REQUEST_BYTES = 1 * 1024 * 1024

/** Per-server handshake deadline; covers connect plus the first tool listing. */
export const HANDSHAKE_TIMEOUT_MS = 15_000

/** How many servers a batch validation probes at once. */
export const VALIDATE_CONCURRENCY = 4

/** A stored health verdict older than this is re-checked on the next demand. */
export const HEALTH_TTL_MS = 5 * 60_000

/** How often the background task looks for expired health verdicts. */
export const HEALTH_SWEEP_INTERVAL_MS = 30_000

/** First retry delay after a failed check; doubles up to {@link BACKOFF_MAX_MS}. */
export const BACKOFF_BASE_MS = 30_000

/** Ceiling for the exponential retry delay. */
export const BACKOFF_MAX_MS = 5 * 60_000

/** Backoff exponent ceiling, so the multiplier cannot overflow. */
export const BACKOFF_MAX_STEPS = 4

/** How many configuration snapshots are kept per scope. */
export const MAX_SNAPSHOTS = 20

/** MCP revision this client announces; servers may answer with another one. */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** Identity this client reports during `initialize`. */
export const CLIENT_INFO = { name: 'dsh-sidebar', version: '0.1.0' } as const

/** Version string reported by the probe's `User-Agent`, when one is sent. */
export const CLIENT_USER_AGENT = 'dsh-sidebar-mcp/0.1.0'

/** Schema depth kept when trimming a discovered tool's `inputSchema`. */
export const SCHEMA_MAX_DEPTH = 6

/** Properties kept per object level when trimming a discovered tool's schema. */
export const SCHEMA_MAX_PROPERTIES = 60

/** Characters kept per description string when trimming a discovered schema. */
export const SCHEMA_MAX_TEXT = 600

/** Tools returned by one search page. */
export const TOOL_SEARCH_LIMIT = 20

/** Tools kept in the per-server discovery cache. */
export const TOOL_CACHE_LIMIT = 500

/** File name holding the global server list inside the profile directory. */
export const GLOBAL_FILENAME = '.mcp-servers.json'

/** Subdirectory of a project root that holds its own server list. */
export const PROJECT_SUBDIR = '.dsh'

/** Directory, under the profile, holding tool-discovery caches. */
export const CACHE_DIRNAME = '.mcp-cache'

/** Directory, under the profile, holding configuration snapshots. */
export const SNAPSHOT_DIRNAME = '.mcp-snapshots'
