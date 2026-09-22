/**
 * Settings-file storage for the MCP server lists, plus the projection of one
 * list into `@deepseek-ai/dsh-mcp-client` entries.
 *
 * Each scope owns one JSON file: the profile directory for `global`, and
 * `<project>/.dsh/` for `project`. Writes are atomic and bump a revision so the
 * browser can detect that someone else committed in the meantime.
 *
 * Do not project these rows into `cordis.patch.yml`: the Loader would register
 * them under the same `serverName` the live remount also claims.
 * `stripManagedBlock` removes a leftover managed block from that file. The live
 * mount is the Host's job; this module only owns bytes on disk.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { PATCH_FILENAME } from './paths.js'
import type { McpScopeDocument, McpServerEntry } from './schema.js'
import { EMPTY_DOCUMENT, decodeDocument } from './schema.js'

/** Package the entries mount. */
const MCP_CLIENT = '@deepseek-ai/dsh-mcp-client'

/** Marker opening this plugin's managed region inside the patch file. */
const BEGIN_MARKER = '# >>> dsh-mcp-settings managed block — edit via the settings UI, not by hand'

/** Marker closing the managed region. */
const END_MARKER = '# <<< dsh-mcp-settings managed block'

/** Result of one write. */
export interface WriteOutcome {
  /** The document as it now exists on disk, revision included. */
  stored: McpScopeDocument
  /** True when the target file already held a different revision. */
  conflicted: boolean
}

/**
 * Read one scope's document.
 * @param file - absolute JSON path.
 * @returns the stored document, or the empty document when absent or unreadable.
 */
export function readDocument(file: string): McpScopeDocument {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return decodeDocument(parsed) ?? EMPTY_DOCUMENT
  } catch {
    // Absent or malformed settings mean "nothing configured yet"; the settings
    // UI is the only writer and rewrites the file on the first save.
    return { ...EMPTY_DOCUMENT, servers: [] }
  }
}

/**
 * Whether the file backing a scope already exists.
 * @param file - absolute JSON path.
 * @returns true when a document has been written there.
 */
export function documentExists(file: string): boolean {
  try {
    readFileSync(file, 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * Persist one scope's document atomically.
 *
 * The write goes to a sibling temporary file and is renamed into place, so a
 * crash mid-write leaves the previous document intact instead of truncated.
 * @param file - absolute JSON path.
 * @param doc - document to store.
 * @param options - `expectedRevision` guards against a lost update.
 * @returns the stored document, and whether the guard rejected the write.
 */
export function writeDocument(
  file: string,
  doc: McpScopeDocument,
  options: { expectedRevision?: number, bump?: boolean } = {},
): WriteOutcome {
  const current = documentExists(file) ? readDocument(file) : undefined
  if (
    options.expectedRevision !== undefined
    && current !== undefined
    && current.revision !== options.expectedRevision
  ) {
    return { stored: current, conflicted: true }
  }
  const bump = options.bump !== false
  const stored: McpScopeDocument = {
    revision: current === undefined
      ? (doc.revision > 0 ? doc.revision : 0)
      : bump ? current.revision + 1 : doc.revision,
    servers: doc.servers,
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const temporary = `${file}.${String(process.pid)}.tmp`
  try {
    writeFileSync(temporary, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, file)
  } catch (error) {
    rmSync(temporary, { force: true })
    throw error
  }
  return { stored, conflicted: false }
}

/**
 * Render one entry as a `dsh-mcp-client` loader row.
 * @param entry - configured server.
 * @param indent - leading spaces for the row's `-` marker.
 * @returns the YAML block for that row, without trailing newline.
 */
export function renderEntry(entry: McpServerEntry, indent = 0): string {
  const pad = ' '.repeat(indent)
  const lines = [
    `${pad}- id: mcp-${entry.id}`,
    `${pad}      name: '${MCP_CLIENT}'`,
    `${pad}      config:`,
    `${pad}        serverName: ${entry.id}`,
    `${pad}        transport: ${entry.transport}`,
  ]
  if (entry.transport === 'stdio') {
    lines.push(`${pad}        command: ${quote(entry.command ?? '')}`)
    if (entry.args !== undefined && entry.args.length > 0) {
      lines.push(`${pad}        args: [${entry.args.map(quote).join(', ')}]`)
    }
    if (entry.cwd !== undefined && entry.cwd !== '') lines.push(`${pad}        cwd: ${quote(entry.cwd)}`)
    const literal = envPairs(entry.env)
    const referenced = envPairs(entry.envEnv)
    if (literal.length > 0 || referenced.length > 0) {
      lines.push(`${pad}        env:`)
      for (const [name, value] of literal) lines.push(`${pad}          ${name}: ${quote(value)}`)
      for (const [name, variable] of referenced) {
        lines.push(`${pad}          ${name}: !!js process.env.${variable}`)
      }
    }
  } else {
    lines.push(`${pad}        url: ${quote(entry.url ?? '')}`)
    const headers = headerPairs(entry)
    if (headers.length > 0) {
      lines.push(`${pad}        headers:`)
      for (const [name, value] of headers) lines.push(`${pad}          ${name}: ${value}`)
    }
  }
  return lines.join('\n')
}

/**
 * Render one entry as a standalone include file's flat entry list.
 *
 * A profile patch layer nests rows under `- insert:`; a standalone include file
 * does not, and nesting one there leaves the row's `name` unread.
 * @param entry - configured server.
 * @returns the file text for a single-entry include.
 */
export function renderStandaloneEntry(entry: McpServerEntry): string {
  return renderEntry(entry, 0)
}

/**
 * Remove a leftover `dsh-mcp-settings` projection from the profile patch.
 *
 * Nothing writes this block any more: projecting rows into the patch file made
 * the Loader register a `serverName` that the live remount also claimed, which
 * double-mounted every server. Older installs may still carry one, so the
 * bootstrap strips it once.
 * @param profileDir - absolute profile directory.
 * @returns true when the file contained a managed block and was rewritten.
 */
export function stripManagedBlock(profileDir: string): boolean {
  const path = join(profileDir, PATCH_FILENAME)
  let existing = ''
  try {
    existing = readFileSync(path, 'utf8')
  } catch {
    // No patch file means there is no leftover projection to remove.
    return false
  }
  if (!existing.includes(BEGIN_MARKER)) return false
  const next = stripBlock(existing)
  if (next === existing) return false
  writeFileSync(path, next, 'utf8')
  return true
}

/**
 * Remove a previously written managed block.
 * @param text - current patch file contents.
 * @returns the text without the block, trailing blank lines trimmed.
 */
function stripBlock(text: string): string {
  const begin = text.indexOf(BEGIN_MARKER)
  if (begin === -1) return text
  const end = text.indexOf(END_MARKER, begin)
  if (end === -1) return text
  const after = text.slice(end + END_MARKER.length)
  return `${text.slice(0, begin)}${after.replace(/^\n+/u, '')}`.trimEnd() + '\n'
}

/**
 * Quote one YAML scalar, always single-quoted so colons and `#` stay literal.
 * @param value - raw value.
 * @returns the quoted scalar.
 */
function quote(value: string): string {
  return `'${value.replace(/'/gu, "''")}'`
}

/**
 * Header declarations for one entry: literal values first, then environment
 * references, with a secret reference winning on a name collision.
 * @param entry - configured server.
 * @returns ordered `[name, rendered value]` pairs.
 */
function headerPairs(entry: McpServerEntry): [string, string][] {
  const pairs: [string, string][] = []
  for (const [name, value] of envPairs(entry.headers)) {
    pairs.push([name, quote(value)])
  }
  for (const [name, variable] of envPairs(entry.headerEnv)) {
    pairs.push([name, `!!js '` + '`Bearer ${process.env.' + variable + '}`' + `'`])
  }
  if (entry.toolsets !== undefined && entry.toolsets !== '' && entry.headers?.['X-MCP-Toolsets'] === undefined) {
    pairs.push(['X-MCP-Toolsets', quote(entry.toolsets)])
  }
  if (entry.readonly === true && entry.headers?.['X-MCP-Readonly'] === undefined) {
    pairs.push(['X-MCP-Readonly', quote('true')])
  }
  return pairs
}

/**
 * Normalize a name-to-value map, dropping blank values.
 * @param map - map to normalize, possibly undefined.
 * @returns the usable pairs.
 */
function envPairs(map: Record<string, string> | undefined): [string, string][] {
  return Object.entries(map ?? {}).filter(([, value]) => value.trim() !== '')
}
