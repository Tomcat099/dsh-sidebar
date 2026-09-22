/**
 * Tool discovery: what a connected server actually offers.
 *
 * A listing is expensive — it is a network round trip per server — so results
 * are cached on disk with the moment they were fetched. The cache is presented
 * as a cache: every row carries the time it was captured, and a stale listing is
 * never described as the server's current state.
 *
 * Schemas come from a remote server and end up rendered in a page, so they are
 * trimmed on the way in: depth, property count, enum size, and description
 * length are all bounded.
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  SCHEMA_MAX_DEPTH,
  SCHEMA_MAX_PROPERTIES,
  SCHEMA_MAX_TEXT,
  TOOL_CACHE_LIMIT,
  TOOL_SEARCH_LIMIT,
} from './constants.js'
import { cacheDir } from './paths.js'
import type { DiscoveredTool, ProbeOptions } from './probe.js'
import { probeEntry } from './probe.js'
import type { McpScope, ScopedServer } from './schema.js'
import { displayName } from './schema.js'

/** File name of the discovery cache inside the profile's cache directory. */
const CACHE_FILENAME = 'tools.json'

/** Top-level shape of the cache file. */
interface ToolCacheFile {
  /** Bumped when the stored shape changes; older files are discarded. */
  version: number
  /** Last successful listing per `${scope}:${id}`. */
  servers: Record<string, { fetchedAt: string, id: string, scope: McpScope, tools: DiscoveredTool[] }>
}

/** One discovered tool, annotated with the server it came from. */
export interface CachedTool extends DiscoveredTool {
  /** Server id, which is also the model-facing tool namespace. */
  server: string
  /** Server display name. */
  serverName: string
  /** Scope the server was read from. */
  scope: McpScope
  /** When this listing was captured; the UI must show it. */
  fetchedAt: string
}

/** Cache file revision this build understands. */
const CACHE_VERSION = 1

/**
 * Absolute path of the discovery cache.
 * @param profileDir - absolute profile directory.
 * @returns the file path.
 */
function cachePath(profileDir: string): string {
  return join(cacheDir(profileDir), CACHE_FILENAME)
}

/**
 * Key one server within the cache.
 * @param server - entry to key.
 * @returns the cache key.
 */
function keyOf(server: Pick<ScopedServer, 'id' | 'scope'>): string {
  return `${server.scope}:${server.id}`
}

/**
 * Read the discovery cache.
 * @param profileDir - absolute profile directory.
 * @returns the parsed cache, or an empty one when absent, stale, or malformed.
 */
export function readToolCache(profileDir: string): ToolCacheFile {
  const empty: ToolCacheFile = { version: CACHE_VERSION, servers: {} }
  try {
    const parsed: unknown = JSON.parse(readFileSync(cachePath(profileDir), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return empty
    const raw = parsed as { version?: unknown, servers?: unknown }
    if (raw.version !== CACHE_VERSION) return empty
    if (typeof raw.servers !== 'object' || raw.servers === null) return empty
    const servers: ToolCacheFile['servers'] = {}
    for (const [key, value] of Object.entries(raw.servers as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null) continue
      const item = value as { fetchedAt?: unknown, id?: unknown, scope?: unknown, tools?: unknown }
      if (typeof item.fetchedAt !== 'string' || typeof item.id !== 'string') continue
      const scope: McpScope = item.scope === 'project' ? 'project' : 'global'
      const tools: DiscoveredTool[] = []
      if (Array.isArray(item.tools)) {
        for (const tool of item.tools) {
          if (typeof tool !== 'object' || tool === null) continue
          const candidate = tool as { name?: unknown }
          if (typeof candidate.name !== 'string') continue
          tools.push(tool as DiscoveredTool)
        }
      }
      servers[key] = { fetchedAt: item.fetchedAt, id: item.id, scope, tools }
    }
    return { version: CACHE_VERSION, servers }
  } catch {
    return empty
  }
}

/**
 * Persist the discovery cache atomically.
 * @param profileDir - absolute profile directory.
 * @param cache - cache to store.
 */
export function writeToolCache(profileDir: string, cache: ToolCacheFile): void {
  const path = cachePath(profileDir)
  const temporary = `${path}.${String(process.pid)}.tmp`
  writeFileSync(temporary, `${JSON.stringify(cache, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
}

/**
 * Record one server's listing.
 * @param profileDir - absolute profile directory.
 * @param server - entry the listing belongs to.
 * @param tools - tools returned by `tools/list`.
 * @param at - capture timestamp; defaults to now.
 * @returns the updated cache.
 */
export function cacheTools(
  profileDir: string,
  server: Pick<ScopedServer, 'id' | 'scope'>,
  tools: readonly DiscoveredTool[],
  at = new Date().toISOString(),
): ToolCacheFile {
  const cache = readToolCache(profileDir)
  cache.servers[keyOf(server)] = {
    fetchedAt: at,
    id: server.id,
    scope: server.scope,
    tools: tools.slice(0, TOOL_CACHE_LIMIT).map(tool => ({ ...tool, inputSchema: trimSchema(tool.inputSchema) })),
  }
  writeToolCache(profileDir, cache)
  return cache
}

/**
 * Drop cached listings for servers that no longer exist.
 * @param profileDir - absolute profile directory.
 * @param servers - the entries that still exist.
 * @returns the keys that were dropped.
 */
export function pruneToolCache(profileDir: string, servers: readonly ScopedServer[]): string[] {
  const live = new Set(servers.map(keyOf))
  const cache = readToolCache(profileDir)
  const dropped = Object.keys(cache.servers).filter(key => !live.has(key))
  if (dropped.length === 0) return []
  for (const key of dropped) delete cache.servers[key]
  writeToolCache(profileDir, cache)
  return dropped
}

/**
 * Flatten the cache into annotated tool rows.
 * @param profileDir - absolute profile directory.
 * @param servers - entries to resolve display names and scope from.
 * @returns one row per cached tool, ordered by server then tool name.
 */
export function listCachedTools(profileDir: string, servers: readonly ScopedServer[]): CachedTool[] {
  const cache = readToolCache(profileDir)
  const byKey = new Map(servers.map(server => [keyOf(server), server]))
  const rows: CachedTool[] = []
  for (const [key, entry] of Object.entries(cache.servers)) {
    const server = byKey.get(key)
    const scope: McpScope = server?.scope ?? entry.scope
    const serverName = server === undefined ? entry.id : displayName(server)
    for (const tool of entry.tools) {
      rows.push({ ...tool, server: entry.id, serverName, scope, fetchedAt: entry.fetchedAt })
    }
  }
  rows.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return rows
}

/**
 * Search cached tool metadata by name, title, and description.
 *
 * Only metadata is searched — the target tool is never invoked, so this cannot
 * cause a side effect on the remote server.
 * @param tools - rows from {@link listCachedTools}.
 * @param input - query plus optional filters.
 * @returns matching rows, best match first.
 */
export function searchCachedTools(
  tools: readonly CachedTool[],
  input: { query: string, server?: string, scope?: McpScope, limit?: number },
): CachedTool[] {
  const needle = input.query.trim().toLowerCase()
  const limit = Math.max(1, Math.min(input.limit ?? TOOL_SEARCH_LIMIT, 100))
  const scored: Array<{ tool: CachedTool, score: number }> = []
  for (const tool of tools) {
    if (input.server !== undefined && input.server !== '' && tool.server !== input.server) continue
    if (input.scope !== undefined && tool.scope !== input.scope) continue
    if (needle === '') {
      scored.push({ tool, score: 0 })
      continue
    }
    const name = tool.name.toLowerCase()
    const title = (tool.title ?? '').toLowerCase()
    const description = (tool.description ?? '').toLowerCase()
    let score = -1
    if (name === needle) score = 100
    else if (name.startsWith(needle)) score = 80
    else if (name.includes(needle)) score = 60
    else if (title.includes(needle)) score = 40
    else if (description.includes(needle)) score = 20
    if (score >= 0) scored.push({ tool, score })
  }
  scored.sort((a, b) => b.score - a.score || (a.tool.name < b.tool.name ? -1 : 1))
  return scored.slice(0, limit).map(item => item.tool)
}

/**
 * Look up one tool's full detail.
 * @param tools - rows from {@link listCachedTools}.
 * @param input - tool name plus disambiguating filters.
 * @returns the tool when exactly one matched, `ambiguous` when several did.
 */
export function findCachedTool(
  tools: readonly CachedTool[],
  input: { name: string, server?: string, scope?: McpScope },
): { ok: true, tool: CachedTool } | { ok: false, reason: 'missing' | 'ambiguous', candidates: CachedTool[] } {
  const matches = tools.filter((tool) => {
    if (tool.name !== input.name) return false
    if (input.server !== undefined && input.server !== '' && tool.server !== input.server) return false
    if (input.scope !== undefined && tool.scope !== input.scope) return false
    return true
  })
  if (matches.length === 0) return { ok: false, reason: 'missing', candidates: [] }
  if (matches.length > 1) return { ok: false, reason: 'ambiguous', candidates: matches }
  return { ok: true, tool: matches[0] }
}

/**
 * Refresh one server's listing and store it.
 * @param profileDir - absolute profile directory.
 * @param server - entry to discover.
 * @param options - probe settings.
 * @returns the outcome, including the tools when the listing succeeded.
 */
export async function refreshTools(
  profileDir: string,
  server: ScopedServer,
  options: ProbeOptions = {},
): Promise<{ ok: boolean, message: string, tools?: CachedTool[] }> {
  const result = await probeEntry(server, options)
  if (!result.ok || result.tools === undefined) {
    return { ok: false, message: result.message }
  }
  const cache = cacheTools(profileDir, server, result.tools, result.checkedAt)
  const entry = cache.servers[keyOf(server)]
  return {
    ok: true,
    message: `发现 ${String(result.tools.length)} 个工具`,
    tools: entry.tools.map(tool => ({
      ...tool,
      server: server.id,
      serverName: displayName(server),
      scope: server.scope,
      fetchedAt: entry.fetchedAt,
    })),
  }
}

/**
 * Compute the model-facing name a tool is exposed under.
 *
 * This mirrors the naming the official client uses for a plain, already-safe
 * tool name; names needing normalization are reported as the Host's business
 * rather than guessed at here.
 * @param serverId - server id.
 * @param toolName - tool name as the server reports it.
 * @returns the public name when it is unambiguous, otherwise undefined.
 */
export function publicToolName(serverId: string, toolName: string): string | undefined {
  if (!/^[A-Za-z0-9_-]{1,64}$/u.test(toolName)) return undefined
  return `mcp__${serverId}__${toolName}`
}

/**
 * Trim a remote JSON Schema down to something safe to render.
 *
 * Recursion is depth-limited, object properties and combining keywords are
 * count-limited, and every string is length-limited. A schema that cannot be
 * understood is replaced by its declared type rather than dropped, so the UI
 * can still say something truthful about it.
 * @param schema - value from a `tools/list` entry.
 * @param depth - current recursion depth; callers omit it.
 * @returns the trimmed value, or undefined when the input was not an object.
 */
export function trimSchema(schema: unknown, depth = 0): unknown {
  if (schema === null || schema === undefined) return undefined
  if (typeof schema === 'string') return schema.slice(0, SCHEMA_MAX_TEXT)
  if (typeof schema === 'number' || typeof schema === 'boolean') return schema
  if (Array.isArray(schema)) {
    return schema.slice(0, 20).map(item => trimSchema(item, depth + 1)).filter(item => item !== undefined)
  }
  if (typeof schema !== 'object') return undefined
  const source = schema as Record<string, unknown>
  if (depth >= SCHEMA_MAX_DEPTH) {
    return source.type === undefined ? {} : { type: source.type }
  }
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(source)) {
    if (key === 'properties') {
      if (typeof value !== 'object' || value === null) continue
      const trimmed: Record<string, unknown> = {}
      for (const [name, child] of Object.entries(value as Record<string, unknown>).slice(0, SCHEMA_MAX_PROPERTIES)) {
        const next = trimSchema(child, depth + 1)
        if (next !== undefined) trimmed[name] = next
      }
      out.properties = trimmed
      continue
    }
    if (key === 'required') {
      if (!Array.isArray(value)) continue
      out.required = value.filter(item => typeof item === 'string').slice(0, SCHEMA_MAX_PROPERTIES)
      continue
    }
    if (key === 'enum') {
      if (!Array.isArray(value)) continue
      out.enum = value.slice(0, 50).map(item => (typeof item === 'string' ? item.slice(0, SCHEMA_MAX_TEXT) : item))
      continue
    }
    if (key === '$defs' || key === 'definitions') continue
    if (key === 'description' || key === 'title') {
      if (typeof value === 'string') out[key] = value.slice(0, SCHEMA_MAX_TEXT)
      continue
    }
    const next = trimSchema(value, depth + 1)
    if (next !== undefined) out[key] = next
  }
  return out
}

/**
 * Summarize one tool's schema into the counts the detail pane shows.
 * @param tool - cached tool.
 * @returns parameter count, required count, and the required names.
 */
export function schemaSummary(tool: CachedTool): { properties: number, required: string[] } {
  const schema = tool.inputSchema
  if (typeof schema !== 'object' || schema === null) return { properties: 0, required: [] }
  const raw = schema as { properties?: unknown, required?: unknown }
  const properties = typeof raw.properties === 'object' && raw.properties !== null
    ? Object.keys(raw.properties as Record<string, unknown>).length
    : 0
  const required = Array.isArray(raw.required)
    ? raw.required.filter((item): item is string => typeof item === 'string')
    : []
  return { properties, required }
}
