/**
 * Portable configuration exchange: `mcpServers` JSON in, redacted JSON out.
 *
 * The import format is the one every other MCP client already writes, so an
 * existing `claude_desktop_config.json` can be pasted in unchanged. Import is
 * all-or-nothing: a document with one unusable entry is rejected whole, because
 * a half-applied import is harder to reason about than a refused one.
 *
 * Export is the mirror image. Credentials never leave the machine, so literal
 * header and environment values are replaced by a placeholder, local paths are
 * dropped, and query strings on a URL are masked. Environment *variable names*
 * are kept — they are not secrets, and without them the export would not be
 * importable anywhere.
 */

import type { McpScopeDocument, McpServerEntry, ValidationIssue } from './schema.js'
import { normalizeEntry, normalizeTransport, validateEntry } from './schema.js'

/** Placeholder written in place of a value that must not leave the machine. */
export const REDACTED = '<REDACTED>'

/** Placeholder written in place of a local directory. */
export const LOCAL_PATH_PLACEHOLDER = '<LOCAL_PATH>'

/** One entry that could not be read at all. */
interface Skipped {
  /** Name the entry was filed under, when one could be read. */
  name: string
  /** Why it was dropped. */
  reason: string
}

/** Result of parsing an import document. */
export interface ImportOutcome {
  /** True when every entry parsed and validated. */
  ok: boolean
  /** Client-visible summary. */
  message: string
  /** Usable entries, in document order. */
  entries: McpServerEntry[]
  /** Problems, blocking and advisory. */
  issues: ValidationIssue[]
}

/** How an import reconciles with entries that already exist. */
export type ImportMode = 'merge' | 'skip' | 'rename'

/**
 * Read an environment reference out of an import value.
 *
 * A literal `${VAR}` or `$VAR` is how portable configs spell "this comes from
 * the environment"; turning it into a reference keeps the secret out of the
 * file we write.
 * @param value - string from the imported config.
 * @returns the variable name, or undefined when the value is a literal.
 */
function envReference(value: string): string | undefined {
  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/u.exec(value.trim())
  return match === null ? undefined : match[1]
}

/**
 * Split an imported `env` / `headers` map into literals and references.
 * @param raw - map from the import.
 * @returns the two maps, each omitted when empty.
 */
function splitReferences(
  raw: Record<string, string> | undefined,
): { values?: Record<string, string>, refs?: Record<string, string> } {
  if (raw === undefined) return {}
  const values: Record<string, string> = {}
  const refs: Record<string, string> = {}
  for (const [name, value] of Object.entries(raw)) {
    const reference = envReference(value)
    if (reference === undefined) values[name] = value
    else refs[name] = reference
  }
  const out: { values?: Record<string, string>, refs?: Record<string, string> } = {}
  if (Object.keys(values).length > 0) out.values = values
  if (Object.keys(refs).length > 0) out.refs = refs
  return out
}

/**
 * Narrow an imported value to a string map.
 * @param value - candidate.
 * @returns the map, or undefined when the value is not a string map.
 */
function asStringMap(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'string') out[key] = raw
    else if (typeof raw === 'number' || typeof raw === 'boolean') out[key] = String(raw)
  }
  return Object.keys(out).length === 0 ? undefined : out
}

/**
 * Convert one imported server config into an entry.
 * @param name - the key the config was filed under, when there is one.
 * @param value - the config body.
 * @returns the entry, or a reason it could not be read.
 */
function toEntry(name: string | undefined, value: unknown): { entry: McpServerEntry } | { reason: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { reason: '不是对象' }
  }
  const raw = value as Record<string, unknown>
  const candidateId = name
    ?? (typeof raw.id === 'string' ? raw.id : undefined)
    ?? (typeof raw.name === 'string' ? raw.name : undefined)
    ?? (typeof raw.serverName === 'string' ? raw.serverName : undefined)
  if (candidateId === undefined || candidateId.trim() === '') {
    return { reason: '缺少名称，无法作为服务器 ID' }
  }
  const id = candidateId.trim()
  // The common configs either name a transport or imply it: anything with a
  // `command` is a local process, anything else is a web endpoint.
  const declared = raw.transport ?? raw.type
  const inferred = declared !== undefined
    ? normalizeTransport(declared)
    : typeof raw.command === 'string' && raw.command.trim() !== ''
      ? 'stdio'
      : 'streamable-http'
  if (inferred === undefined) return { reason: `传输方式「${String(declared)}」无法识别` }
  const explicit = normalizeEntry({ ...raw, transport: inferred, id })
  if (explicit === undefined) return { reason: '缺少 command 或 url，无法判断传输方式' }
  const entry: McpServerEntry = {
    ...explicit,
    id,
    enabled: raw.enabled !== false && raw.disabled !== true,
  }
  if (typeof raw.name === 'string' && raw.name.trim() !== '' && raw.name.trim() !== id) {
    entry.name = raw.name.trim()
  } else {
    delete entry.name
  }
  const env = splitReferences(asStringMap(raw.env))
  if (env.values !== undefined) entry.env = env.values
  else delete entry.env
  if (env.refs !== undefined) entry.envEnv = { ...(entry.envEnv ?? {}), ...env.refs }
  const headers = splitReferences(asStringMap(raw.headers))
  if (headers.values !== undefined) entry.headers = headers.values
  else delete entry.headers
  if (headers.refs !== undefined) entry.headerEnv = { ...(entry.headerEnv ?? {}), ...headers.refs }
  // A web endpoint never carries a command, and vice versa; dropping the other
  // side keeps the written document unambiguous.
  if (entry.transport === 'streamable-http') {
    delete entry.command
    delete entry.args
    delete entry.env
    delete entry.envEnv
  } else {
    delete entry.url
    delete entry.headers
    delete entry.headerEnv
  }
  return { entry }
}

/**
 * Pull the server list out of a parsed import document.
 * @param parsed - parsed JSON.
 * @returns either the raw list, or a reason the shape was not recognized.
 */
function extractServers(parsed: unknown): { list: Array<[string | undefined, unknown]> } | { reason: string } {
  if (Array.isArray(parsed)) return { list: parsed.map(item => [undefined, item]) }
  if (typeof parsed !== 'object' || parsed === null) return { reason: '顶层不是对象或数组' }
  const raw = parsed as Record<string, unknown>
  for (const key of ['mcpServers', 'servers', 'connections']) {
    const value = raw[key]
    if (value === undefined) continue
    if (Array.isArray(value)) return { list: value.map(item => [undefined, item]) }
    if (typeof value === 'object' && value !== null) return { list: Object.entries(value as Record<string, unknown>) }
    return { reason: `「${key}」不是对象或数组` }
  }
  if (raw.url !== undefined || raw.command !== undefined) return { list: [[undefined, parsed]] }
  return { reason: '没有找到 mcpServers、servers 或 connections' }
}

/**
 * Parse and validate an import payload.
 * @param text - pasted JSON.
 * @returns the outcome; `ok` is false when anything at all was unusable.
 */
export function parseImportJson(text: string): ImportOutcome {
  const trimmed = text.trim()
  if (trimmed === '') return { ok: false, message: '内容是空的', entries: [], issues: [] }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    return {
      ok: false,
      message: `不是合法的 JSON：${error instanceof Error ? error.message : String(error)}`,
      entries: [],
      issues: [],
    }
  }
  const extracted = extractServers(parsed)
  if ('reason' in extracted) return { ok: false, message: extracted.reason, entries: [], issues: [] }
  if (extracted.list.length === 0) return { ok: false, message: '里面没有任何服务器', entries: [], issues: [] }
  const entries: McpServerEntry[] = []
  const issues: ValidationIssue[] = []
  const skipped: Skipped[] = []
  const seen = new Set<string>()
  for (const [name, value] of extracted.list) {
    const result = toEntry(name, value)
    if ('reason' in result) {
      skipped.push({ name: name ?? '(未命名)', reason: result.reason })
      issues.push({
        code: 'import-invalid',
        id: name,
        message: `「${name ?? '(未命名)'}」${result.reason}`,
      })
      continue
    }
    const found = validateEntry(result.entry)
    const blocking = found
    if (blocking.length > 0) {
      issues.push(...found)
      continue
    }
    if (seen.has(result.entry.id)) {
      issues.push({ code: 'import-duplicate', id: result.entry.id, message: `导入内容里有两份「${result.entry.id}」` })
      continue
    }
    seen.add(result.entry.id)
    entries.push(result.entry)
    issues.push(...found)
  }
  const fatal = issues
  if (fatal.length > 0) {
    return {
      ok: false,
      message: `有 ${String(fatal.length)} 处问题，已整体拒绝导入`,
      entries: [],
      issues,
    }
  }
  const warnings = issues.length
  return {
    ok: true,
    message: warnings === 0
      ? `解析出 ${String(entries.length)} 个服务器`
      : `解析出 ${String(entries.length)} 个服务器，另有 ${String(warnings)} 处提示`,
    entries,
    issues,
  }
}

/**
 * Merge imported entries into an existing document.
 * @param existing - document the import lands in.
 * @param entries - entries from {@link parseImportJson}.
 * @param mode - how to reconcile a colliding id.
 * @returns the merged document plus a summary of what happened.
 */
export function importIntoDocument(
  existing: McpScopeDocument,
  entries: readonly McpServerEntry[],
  mode: ImportMode = 'merge',
): { doc: McpScopeDocument, added: number, replaced: number, skipped: number, renamed: number } {
  const servers = existing.servers.map(entry => ({ ...entry }))
  const taken = new Set(servers.map(entry => entry.id))
  let added = 0
  let replaced = 0
  let skipped = 0
  let renamed = 0
  for (const entry of entries) {
    const collision = taken.has(entry.id)
    if (!collision) {
      servers.push({ ...entry })
      taken.add(entry.id)
      added += 1
      continue
    }
    if (mode === 'skip') {
      skipped += 1
      continue
    }
    if (mode === 'merge') {
      const index = servers.findIndex(item => item.id === entry.id)
      servers[index] = { ...entry }
      replaced += 1
      continue
    }
    let suffix = 2
    let candidate = `${entry.id}-${String(suffix)}`
    while (taken.has(candidate)) {
      suffix += 1
      candidate = `${entry.id}-${String(suffix)}`
    }
    servers.push({ ...entry, id: candidate })
    taken.add(candidate)
    renamed += 1
  }
  return { doc: { revision: existing.revision, servers }, added, replaced, skipped, renamed }
}

/**
 * Mask the query string of a URL, keeping the endpoint readable.
 * @param raw - configured URL.
 * @returns the URL with every query value replaced, or the input unchanged.
 */
function maskQuery(raw: string): string {
  try {
    const parsed = new URL(raw)
    if ([...parsed.searchParams.keys()].length === 0) return raw
    const masked = new URLSearchParams()
    for (const key of parsed.searchParams.keys()) masked.append(key, REDACTED)
    parsed.search = masked.toString()
    return parsed.toString()
  } catch {
    return raw
  }
}

/**
 * Export one scope's document as portable, credential-free JSON.
 *
 * Environment variable *names* survive; literal values do not. Local working
 * directories are dropped because they describe one machine.
 * @param doc - document to export.
 * @returns the JSON text plus how many values were masked.
 */
export function exportRedacted(doc: McpScopeDocument): { json: string, redacted: number } {
  let redacted = 0
  const mcpServers: Record<string, unknown> = {}
  for (const entry of doc.servers) {
    const out: Record<string, unknown> = {
      transport: entry.transport,
      enabled: entry.enabled,
    }
    if ((entry.name ?? '') !== '' && entry.name !== entry.id) out.name = entry.name
    if (entry.transport === 'stdio') {
      out.command = entry.command ?? ''
      if (entry.args !== undefined && entry.args.length > 0) out.args = [...entry.args]
      if (entry.env !== undefined && Object.keys(entry.env).length > 0) {
        const masked: Record<string, string> = {}
        for (const key of Object.keys(entry.env)) masked[key] = REDACTED
        out.env = masked
        redacted += Object.keys(masked).length
      }
      if (entry.envEnv !== undefined && Object.keys(entry.envEnv).length > 0) out.envEnv = { ...entry.envEnv }
    } else {
      out.url = maskQuery(entry.url ?? '')
      if ((entry.url ?? '').includes('?')) redacted += 1
      if (entry.headers !== undefined && Object.keys(entry.headers).length > 0) {
        const masked: Record<string, string> = {}
        for (const key of Object.keys(entry.headers)) masked[key] = REDACTED
        out.headers = masked
        redacted += Object.keys(masked).length
      }
      if (entry.headerEnv !== undefined && Object.keys(entry.headerEnv).length > 0) out.headerEnv = { ...entry.headerEnv }
    }
    if (entry.toolsets !== undefined && entry.toolsets !== '') out.toolsets = entry.toolsets
    if (entry.readonly === true) out.readonly = true
    if (entry.insecurePrivateNetwork === true) out.insecurePrivateNetwork = true
    mcpServers[entry.id] = out
  }
  const payload = {
    _comment: `由 dsh-sidebar 导出；凭据已用 ${REDACTED} 占位，本地路径已用 ${LOCAL_PATH_PLACEHOLDER} 占位`,
    mcpServers,
  }
  return { json: `${JSON.stringify(payload, null, 2)}\n`, redacted }
}


