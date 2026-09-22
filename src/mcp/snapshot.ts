/**
 * Configuration snapshots, one append-only history per scope.
 *
 * Every committed write leaves the previous document behind as an `auto`
 * snapshot, which is what makes the "rollback to revision N" affordance in the
 * scope editor real rather than decorative. `manual` snapshots are the ones a
 * user names before a risky edit.
 *
 * The history is capped. When the cap is reached the oldest `auto` snapshot is
 * dropped first, so a long editing session cannot evict the checkpoint someone
 * deliberately made.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { MAX_SNAPSHOTS } from './constants.js'
import { snapshotDir } from './paths.js'
import type { McpScope, McpScopeDocument } from './schema.js'
import { decodeDocument } from './schema.js'

/** How a snapshot came to exist. */
export type SnapshotKind = 'auto' | 'manual'

/** Metadata describing one stored snapshot. */
export interface SnapshotMeta {
  /** Stable identifier, also the file stem. */
  id: string
  /** ISO timestamp of creation. */
  at: string
  /** User-supplied label, or a generated one for auto snapshots. */
  label: string
  /** Whether this was an automatic pre-write checkpoint. */
  kind: SnapshotKind
  /** Document revision captured. */
  revision: number
  /** Scope the document came from. */
  scope: McpScope
  /** Number of servers in the captured document. */
  serverCount: number
}

/** One snapshot's full payload, as stored on disk. */
interface SnapshotFile {
  meta: SnapshotMeta
  doc: McpScopeDocument
}

/**
 * Directory holding one scope's snapshots.
 * @param profileDir - absolute profile directory.
 * @param scope - scope whose history is wanted.
 * @returns the absolute directory, created when absent.
 */
function scopeDir(profileDir: string, scope: McpScope): string {
  const dir = join(snapshotDir(profileDir), scope)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return dir
}

/**
 * Build a sortable, filesystem-safe snapshot id.
 * @param at - ISO timestamp.
 * @param kind - snapshot kind.
 * @returns the identifier.
 */
function makeId(at: string, kind: SnapshotKind): string {
  return `${at.replace(/[:.]/gu, '-')}-${kind}`
}

/**
 * Read one snapshot file.
 * @param path - absolute path to the snapshot.
 * @returns the payload, or undefined when the file is unreadable or malformed.
 */
function readSnapshotFile(path: string): SnapshotFile | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const raw = parsed as { meta?: unknown, doc?: unknown }
    if (typeof raw.meta !== 'object' || raw.meta === null) return undefined
    const meta = raw.meta as SnapshotMeta
    if (typeof meta.id !== 'string' || typeof meta.at !== 'string') return undefined
    const doc = decodeDocument(raw.doc)
    if (doc === undefined) return undefined
    return { meta, doc }
  } catch {
    return undefined
  }
}

/**
 * List one scope's snapshots, newest first.
 * @param profileDir - absolute profile directory.
 * @param scope - scope whose history is wanted.
 * @returns metadata for every readable snapshot.
 */
export function listSnapshots(profileDir: string, scope: McpScope): SnapshotMeta[] {
  const dir = scopeDir(profileDir, scope)
  const metas: SnapshotMeta[] = []
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue
    const file = readSnapshotFile(join(dir, name))
    if (file !== undefined) metas.push(file.meta)
  }
  metas.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return metas
}

/**
 * Load one snapshot's document.
 * @param profileDir - absolute profile directory.
 * @param scope - scope the snapshot belongs to.
 * @param id - snapshot identifier.
 * @returns the captured document, or undefined when it is gone.
 */
export function readSnapshot(profileDir: string, scope: McpScope, id: string): McpScopeDocument | undefined {
  const path = join(scopeDir(profileDir, scope), `${id}.json`)
  return existsSync(path) ? readSnapshotFile(path)?.doc : undefined
}

/**
 * Delete one snapshot.
 * @param profileDir - absolute profile directory.
 * @param scope - scope the snapshot belongs to.
 * @param id - snapshot identifier.
 * @returns true when a file was removed.
 */
export function deleteSnapshot(profileDir: string, scope: McpScope, id: string): boolean {
  const path = join(scopeDir(profileDir, scope), `${id}.json`)
  if (!existsSync(path)) return false
  rmSync(path, { force: true })
  return true
}

/**
 * Drop snapshots until the scope holds at most {@link MAX_SNAPSHOTS}.
 *
 * Automatic checkpoints are sacrificed before manual ones; among equals the
 * oldest goes first.
 * @param profileDir - absolute profile directory.
 * @param scope - scope to prune.
 * @returns identifiers of the snapshots that were removed.
 */
function prune(profileDir: string, scope: McpScope): string[] {
  const metas = listSnapshots(profileDir, scope)
  if (metas.length <= MAX_SNAPSHOTS) return []
  const ordered = [...metas].reverse().sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'auto' ? -1 : 1
    return a.at < b.at ? -1 : 1
  })
  const removed: string[] = []
  for (const meta of ordered) {
    if (metas.length - removed.length <= MAX_SNAPSHOTS) break
    if (deleteSnapshot(profileDir, scope, meta.id)) removed.push(meta.id)
  }
  return removed
}

/**
 * Capture one document as a snapshot.
 *
 * An `auto` capture is skipped when the newest snapshot already holds the same
 * servers, so a sequence of no-op saves does not fill the history.
 * @param profileDir - absolute profile directory.
 * @param scope - scope the document came from.
 * @param doc - document to capture.
 * @param options - label and kind; defaults to an automatic checkpoint.
 * @returns the new snapshot's metadata, or undefined when it was skipped.
 */
export function createSnapshot(
  profileDir: string,
  scope: McpScope,
  doc: McpScopeDocument,
  options: { label?: string, kind?: SnapshotKind, at?: string } = {},
): SnapshotMeta | undefined {
  const kind = options.kind ?? 'auto'
  const at = options.at ?? new Date().toISOString()
  const newest = listSnapshots(profileDir, scope)[0]
  if (kind === 'auto' && newest !== undefined) {
    const previous = readSnapshot(profileDir, scope, newest.id)
    if (previous !== undefined && sameServers(previous, doc)) return undefined
  }
  const meta: SnapshotMeta = {
    id: makeId(at, kind),
    at,
    label: (options.label ?? '').trim() === ''
      ? kind === 'auto' ? '保存前自动备份' : '手动备份'
      : (options.label as string).trim(),
    kind,
    revision: doc.revision,
    scope,
    serverCount: doc.servers.length,
  }
  const path = join(scopeDir(profileDir, scope), `${meta.id}.json`)
  const temporary = `${path}.tmp`
  const payload: SnapshotFile = { meta, doc: { revision: doc.revision, servers: doc.servers } }
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, path)
  prune(profileDir, scope)
  return meta
}

/**
 * Compare two documents by their server list.
 * @param left - first document.
 * @param right - second document.
 * @returns true when both hold the same servers.
 */
function sameServers(left: McpScopeDocument, right: McpScopeDocument): boolean {
  return JSON.stringify(left.servers) === JSON.stringify(right.servers)
}

/**
 * Describe what restoring a snapshot would change.
 * @param profileDir - absolute profile directory.
 * @param scope - scope the snapshot belongs to.
 * @param id - snapshot identifier.
 * @param current - document the scope holds right now.
 * @returns a summary the UI can show before the user commits.
 */
export function previewRestore(
  profileDir: string,
  scope: McpScope,
  id: string,
  current: McpScopeDocument,
): { ok: boolean, message: string, meta?: SnapshotMeta, added?: string[], removed?: string[], changed?: string[] } {
  const meta = listSnapshots(profileDir, scope).find(item => item.id === id)
  if (meta === undefined) return { ok: false, message: `快照「${id}」不存在` }
  const doc = readSnapshot(profileDir, scope, id)
  if (doc === undefined) return { ok: false, message: `快照「${id}」无法读取` }
  const before = new Map(current.servers.map(entry => [entry.id, entry]))
  const after = new Map(doc.servers.map(entry => [entry.id, entry]))
  const added = [...after.keys()].filter(key => !before.has(key))
  const removed = [...before.keys()].filter(key => !after.has(key))
  const changed = [...after.keys()].filter((key) => {
    const from = before.get(key)
    const to = after.get(key)
    return from !== undefined && to !== undefined && JSON.stringify(from) !== JSON.stringify(to)
  })
  return { ok: true, message: '已生成恢复预览', meta, added, removed, changed }
}
