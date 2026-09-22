/**
 * HTTP surface for the MCP page.
 *
 * Every route returns JSON and never throws: a failure comes back as a payload
 * with `ok: false` and a sentence a user can act on. The browser is the only
 * caller, and it is kept deliberately dumb — validation, probing, redaction, and
 * snapshotting all happen here so the page cannot disagree with the stored file.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { findProjectRoot } from '../skills.js'
import {
  MAX_REQUEST_BYTES,
  TOOL_SEARCH_LIMIT,
} from './constants.js'
import {
  findCachedTool,
  listCachedTools,
  publicToolName,
  readToolCache,
  refreshTools,
  searchCachedTools,
  type CachedTool,
} from './catalog.js'
import type { HealthSummary } from './diagnostics.js'
import type { HealthPassOptions } from './health.js'
import { applyCredentialMigration, planCredentialMigration } from './credentials.js'
import type { ProbeOptions, ProbeResult } from './probe.js'
import { probeEntry } from './probe.js'
import type { McpScope, McpScopeDocument, McpServerEntry, ScopedServer } from './schema.js'
import { displayName, normalizeEntry, validateDocument } from './schema.js'
import {
  allServers,
  commit,
  previewScopeRestore,
  readContext,
  scopeLabel,
  snapshotDocument,
  snapshotHistory,
  transferBetween,
  viewFor,
  type ScopeContext,
} from './scope.js'
import { createSnapshot, deleteSnapshot } from './snapshot.js'
import { exportRedacted, importIntoDocument, parseImportJson, type ImportMode } from './transfer.js'

/** Route prefix owned by the MCP feature. */
export const ROUTE_PREFIX = '/mcp-settings'

/** Route serving the stored global server list; kept for older settings pages. */
export const SERVERS_ROUTE = `${ROUTE_PREFIX}/servers`

/** Route reporting per-server health; kept for older settings pages. */
export const HEALTH_ROUTE = `${ROUTE_PREFIX}/health`

/** Everything the routes need from the Host half. */
export interface McpRuntime {
  /** Absolute profile directory. */
  profileDir: string
  /** Absolute DSH home directory, which owns the `.env` credentials live in. */
  dshHome: string
  /** Project whose list is currently in play, when one is open. */
  activeProjectRoot(): string | undefined
  /** Adopt a project as the active one, remounting when it changes. */
  setActiveProjectRoot(root: string | undefined): void
  /** Load both scopes. */
  context(): ScopeContext
  /** Run a health pass and return its summary. */
  healthPass(options: HealthPassOptions): Promise<HealthSummary>
  /** Rebuild the mounted subtree set from the current context. */
  remount(): Promise<void>
  /** Logger for route-level warnings. */
  warn(message: string, ...args: unknown[]): void
}

/** One route the MCP page can call. */
interface Route {
  /** Path, exactly as registered. */
  path: string
  /** Methods accepted. */
  methods: string[]
  /**
   * Handle one request.
   * @param request - incoming request.
   * @param response - response to complete.
   * @param url - parsed request URL.
   */
  handle(request: IncomingMessage, response: ServerResponse, url: URL): Promise<void> | void
}

/**
 * Complete one request with a JSON body.
 * @param response - response to finish.
 * @param status - HTTP status.
 * @param payload - value to serialize.
 */
function send(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/**
 * Read a request body with a hard size ceiling.
 * @param request - incoming request.
 * @param maxBytes - ceiling in bytes.
 * @returns the decoded text.
 * @throws when the body exceeds the ceiling.
 */
async function readBody(request: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.byteLength
    if (total > maxBytes) throw new Error(`请求体超过 ${String(Math.round(maxBytes / 1024))} KiB 上限`)
    chunks.push(buffer)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * Read and parse a JSON body.
 * @param request - incoming request.
 * @param maxBytes - ceiling in bytes.
 * @returns the parsed value.
 * @throws when the body is unreadable, oversized, or not JSON.
 */
async function readJson(request: IncomingMessage, maxBytes = MAX_REQUEST_BYTES): Promise<unknown> {
  const text = await readBody(request, maxBytes)
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

/**
 * Narrow a parsed body to a plain object.
 * @param value - parsed JSON.
 * @returns the object.
 * @throws when the value is not an object.
 */
function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('请求体必须是一个 JSON 对象')
  }
  return value as Record<string, unknown>
}

/**
 * Read a scope name from a value.
 * @param value - candidate.
 * @param fallback - value to use when the candidate is absent.
 * @returns the scope.
 */
function asScope(value: unknown, fallback: McpScope = 'global'): McpScope {
  if (value === undefined || value === null || value === '') return fallback
  if (value === 'project' || value === 'global') return value
  throw new Error('scope 只能是 global 或 project')
}

/**
 * Coerce a candidate server list into entries.
 *
 * Values already tagged with a scope are unwrapped, so the UI can post back
 * exactly what {@link allServers} gave it.
 * @param value - candidate list.
 * @returns the entries.
 * @throws when the value is not an array or an entry is unusable.
 */
function asServers(value: unknown): McpServerEntry[] {
  if (!Array.isArray(value)) throw new Error('servers 必须是数组')
  const entries: McpServerEntry[] = []
  for (const item of value) {
    const entry = normalizeEntry(item)
    if (entry === undefined) throw new Error('有一条服务器的格式无法识别（需要 id 与 transport）')
    entries.push(entry)
  }
  return entries
}

/**
 * Read the candidate document out of a request body.
 * @param body - parsed body.
 * @param current - revision the scope currently holds.
 * @returns the candidate document.
 * @throws when the body has no usable server list.
 */
function asDocument(body: Record<string, unknown>, current: number): McpScopeDocument {
  const servers = asServers(body.servers)
  const revision = typeof body.revision === 'number' ? body.revision : current
  return { revision, servers }
}

/**
 * Read the expected revision out of a request body.
 * @param body - parsed body.
 * @returns the revision, or undefined when the caller did not pin one.
 */
function asExpectedRevision(body: Record<string, unknown>): number | undefined {
  const value = body.expectedRevision
  if (value === undefined || value === null || value === '') return undefined
  const revision = Number(value)
  if (!Number.isFinite(revision)) throw new Error('expectedRevision 必须是数字')
  return revision
}

/**
 * Whether two entries point at the same place.
 *
 * Only the fields that decide *where* a connection goes are compared, so
 * renaming a server, rotating a token, or moving a credential between `headers`
 * and `headerEnv` none of them count as a new destination.
 * @param left - first entry.
 * @param right - second entry.
 * @returns true when a probe of one would answer for the other.
 */
function pointsElsewhere(left: McpServerEntry, right: McpServerEntry): boolean {
  if (left.transport !== right.transport) return true
  return JSON.stringify([left.url, left.command, left.args, left.cwd])
    !== JSON.stringify([right.url, right.command, right.args, right.cwd])
}

/**
 * Whether two entries differ at all in how they connect.
 * @param left - first entry.
 * @param right - second entry.
 * @returns true when anything relevant changed.
 */
function differs(left: McpServerEntry, right: McpServerEntry): boolean {
  return pointsElsewhere(left, right)
    || JSON.stringify(left.headers) !== JSON.stringify(right.headers)
    || JSON.stringify(left.headerEnv) !== JSON.stringify(right.headerEnv)
    || JSON.stringify(left.env) !== JSON.stringify(right.env)
    || JSON.stringify(left.envEnv) !== JSON.stringify(right.envEnv)
    || left.toolsets !== right.toolsets
    || left.readonly !== right.readonly
}

/**
 * Split the changed entries into "must answer" and "tell me if it does not".
 *
 * A new entry, or one whose destination moved, must complete a handshake: a
 * wrong URL is not something waiting fixes. A credential or setting change only
 * warns instead, for two reasons. Rotating a token should not require the new
 * token to already work before it can be saved — after a credential migration
 * the value is not even in this process's environment until the next restart,
 * so blocking there would be an unbreakable loop. And the health check turns
 * the row red moments later anyway, which is the right place for that news.
 * @param current - document on disk.
 * @param next - document being saved.
 * @returns the two probe sets, both limited to enabled entries.
 */
export function splitProbeTargets(
  current: McpScopeDocument,
  next: McpScopeDocument,
): { must: McpServerEntry[], may: McpServerEntry[] } {
  const before = new Map(current.servers.map(entry => [entry.id, entry]))
  const must: McpServerEntry[] = []
  const may: McpServerEntry[] = []
  for (const entry of next.servers) {
    if (!entry.enabled) continue
    const previous = before.get(entry.id)
    if (previous === undefined || pointsElsewhere(previous, entry)) {
      must.push(entry)
      continue
    }
    if (differs(previous, entry)) may.push(entry)
  }
  return { must, may }
}

/**
 * Describe one probe outcome for the UI.
 * @param entry - entry that was probed.
 * @param result - probe outcome.
 * @returns the row.
 */
function probeRow(entry: McpServerEntry, result: ProbeResult): Record<string, unknown> {
  return {
    id: entry.id,
    name: displayName(entry),
    ok: result.ok,
    kind: result.kind,
    message: result.message,
    toolCount: result.tools?.length,
    protocolVersion: result.protocolVersion,
    serverName: result.serverInfo?.name,
    checkedAt: result.checkedAt,
  }
}

/**
 * Combine an edited scope with the untouched one read from disk.
 * @param context - loaded context.
 * @param scope - scope the edited list belongs to.
 * @param edited - entries as they currently stand in the form.
 * @returns both scopes, with the edited side taking precedence.
 */
function mergeScopeServers(
  context: ScopeContext,
  scope: McpScope,
  edited: readonly McpServerEntry[],
): ScopedServer[] {
  const rows: ScopedServer[] = []
  for (const entry of scope === 'project' ? context.global.servers : context.project?.servers ?? []) {
    rows.push({ ...entry, scope: scope === 'project' ? 'global' : 'project' })
  }
  for (const entry of edited) rows.push({ ...entry, scope })
  return rows
}

/**
 * Adopt a workspace as the active project, resolved to its repository root.
 *
 * Skills already anchor their project scope at the enclosing repository, so MCP
 * does the same: a workspace nested inside a repo shares that repository's
 * list instead of growing a second one beside it.
 * @param runtime - Host services.
 * @param cwd - workspace path, or null/empty to forget the active project.
 */
async function adoptProject(runtime: McpRuntime, cwd: string | null): Promise<void> {
  const next = cwd === null || cwd === '' ? undefined : await findProjectRoot(cwd)
  if (next === runtime.activeProjectRoot()) return
  runtime.setActiveProjectRoot(next)
  await runtime.remount()
}

/**
 * Build the whole set of routes.
 * @param runtime - Host services the routes call into.
 * @returns the route table.
 */
function routes(runtime: McpRuntime): Route[] {
  return [
    // ---- State -------------------------------------------------------------
    {
      path: `${ROUTE_PREFIX}/state`,
      methods: ['GET'],
      handle: async (request, response, url) => {
        await adoptProject(runtime, url.searchParams.get('cwd'))
        const context = runtime.context()
        const servers = allServers(context)
        const cache = readToolCache(runtime.profileDir)
        const cachedServers = Object.values(cache.servers)
        const newest = cachedServers.map(entry => entry.fetchedAt).sort().pop()
        send(response, 200, {
          ok: true,
          profileDir: runtime.profileDir,
          activeProjectRoot: context.activeProjectRoot ?? null,
          global: {
            revision: context.global.revision,
            present: context.global.present,
            servers: context.global.servers,
          },
          project: context.project === undefined
            ? null
            : {
                revision: context.project.revision,
                present: context.project.present,
                root: context.project.root,
                servers: context.project.servers,
              },
          health: await runtime.healthPass({ defer: true }),
          tools: {
            count: listCachedTools(runtime.profileDir, servers).length,
            fetchedAt: newest ?? null,
            servers: cachedServers.length,
          },
        })
      },
    },

    // ---- Legacy single-document routes, kept for the global scope ----------
    {
      path: SERVERS_ROUTE,
      methods: ['GET', 'POST'],
      handle: async (request, response) => {
        const context = runtime.context()
        if (request.method === 'GET') {
          send(response, 200, { servers: context.global.servers, revision: context.global.revision })
          return
        }
        const body = asRecord(await readJson(request))
        const doc = asDocument(body, context.global.revision)
        const outcome = commit(runtime.context(), 'global', doc, { expectedRevision: asExpectedRevision(body) })
        if (!outcome.ok) {
          send(response, 409, { ok: false, error: outcome.message, issues: outcome.issues, conflicted: outcome.conflicted })
          return
        }
        await runtime.remount()
        send(response, 200, { ok: true, health: await runtime.healthPass({ force: true }) })
      },
    },

    // ---- Save, with validation and pre-flight in one round trip ------------
    {
      path: `${ROUTE_PREFIX}/save`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const context = runtime.context()
        const view = viewFor(context, scope)
        if (view === undefined) {
          send(response, 200, { ok: false, stage: 'scope', error: '当前没有打开的项目，无法保存项目级配置' })
          return
        }
        const doc = asDocument(body, view.revision)
        const verdict = validateDocument(doc)
        if (!verdict.ok) {
          const problems = verdict.issues
          send(response, 200, {
            ok: false,
            stage: 'validate',
            error: problems.map(issue => issue.message).join('；'),
            issues: verdict.issues,
          })
          return
        }
        // A new destination, or one that moved, must answer before it lands. A
        // credential or setting change only produces a warning, so rotating a
        // token never requires the new token to already work.
        let warnings: Array<Record<string, unknown>> = []
        if (body.probe !== false) {
          const current: McpScopeDocument = { revision: view.revision, servers: view.servers }
          const { must, may } = splitProbeTargets(current, doc)
          const [mustRows, mayRows] = await Promise.all([
            Promise.all(must.map(async entry => probeRow(entry, await probeEntry(entry, {})))),
            Promise.all(may.map(async entry => probeRow(entry, await probeEntry(entry, {})))),
          ])
          warnings = mayRows.filter(row => row.ok !== true && row.kind !== 'managed')
          const failed = mustRows.filter(row => row.ok !== true && row.kind !== 'managed')
          if (failed.length > 0) {
            const names = failed.map(row => `「${String(row.name ?? row.id)}」`).join('、')
            send(response, 200, {
              ok: false,
              stage: 'probe',
              error:
                `${names}的新地址没有握上手，配置没有保存。` +
                `失败原因已经写在那一行展开后的诊断里；只想先把配置存下来就点「跳过握手保存」`,
              issues: verdict.issues,
              results: [...mustRows, ...mayRows],
            })
            return
          }
        }
        const outcome = commit(context, scope, doc, { expectedRevision: asExpectedRevision(body) })
        if (!outcome.ok) {
          send(response, 200, {
            ok: false,
            stage: outcome.conflicted === true ? 'conflict' : 'commit',
            error: outcome.message,
            issues: outcome.issues,
            current: outcome.current,
          })
          return
        }
        await runtime.remount()
        send(response, 200, {
          ok: true,
          message: warnings.length === 0
            ? `已保存到${scopeLabel(scope)}`
            : `已保存到${scopeLabel(scope)}；有 ${String(warnings.length)} 条只改了凭据或设置的服务器没有通过握手，状态见列表`,
          revision: outcome.stored?.revision,
          issues: verdict.issues,
          warnings,
          health: await runtime.healthPass({ force: true }),
        })
      },
    },

    // ---- Validation and pre-flight probing ---------------------------------
    {
      path: `${ROUTE_PREFIX}/validate`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const view = viewFor(runtime.context(), scope)
        if (view === undefined) {
          send(response, 200, { ok: false, error: '当前没有打开的项目' })
          return
        }
        const doc = asDocument(body, view.revision)
        const verdict = validateDocument(doc)
        send(response, 200, {
          ok: verdict.ok,
          issues: verdict.issues,
          problems: verdict.issues,
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/probe`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const view = viewFor(runtime.context(), scope)
        if (view === undefined) {
          send(response, 200, { ok: false, error: '当前没有打开的项目' })
          return
        }
        const doc = asDocument(body, view.revision)
        const verdict = validateDocument(doc)
        if (!verdict.ok) {
          const problems = verdict.issues
          send(response, 200, { ok: false, reason: 'invalid', error: problems.map(issue => issue.message).join('；'), issues: verdict.issues })
          return
        }
        const current: McpScopeDocument = { revision: view.revision, servers: view.servers }
        const changed = splitProbeTargets(current, doc)
        const targets = body.all === true
          ? doc.servers.filter(entry => entry.enabled)
          : [...changed.must, ...changed.may]
        const options: ProbeOptions = {}
        const results = await Promise.all(targets.map(async entry => probeRow(entry, await probeEntry(entry, options))))
        const failed = results.filter(row => row.ok !== true && row.kind !== 'managed')
        send(response, 200, {
          ok: failed.length === 0,
          reason: failed.length === 0 ? 'ok' : 'probe',
          error: failed.length === 0 ? '' : `${String(failed.length)} 个服务器连接失败`,
          checked: results.length,
          results,
        })
      },
    },

    // ---- Loading one project -------------------------------------------------
    {
      path: `${ROUTE_PREFIX}/open-project`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const cwd = typeof body.cwd === 'string' ? body.cwd.trim() : ''
        await adoptProject(runtime, cwd === '' ? null : cwd)
        send(response, 200, { ok: true, activeProjectRoot: runtime.context().activeProjectRoot ?? null })
      },
    },

    // ---- Scope transfer ------------------------------------------------------
    {
      path: `${ROUTE_PREFIX}/scope/transfer`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const from = asScope(body.from)
        const to = asScope(body.to, 'project')
        const ids = Array.isArray(body.ids) ? body.ids.filter((item): item is string => typeof item === 'string') : []
        const mode: 'copy' | 'move' = body.mode === 'move' ? 'move' : 'copy'
        const plan = transferBetween(runtime.context(), { from, to, ids, mode })
        if (plan.ok && body.apply !== true) {
          send(response, 200, { ok: true, preview: true, message: plan.message, target: plan.target })
          return
        }
        if (!plan.ok) {
          send(response, 200, { ok: false, error: plan.message, issues: plan.issues })
          return
        }
        const context = runtime.context()
        const targetOutcome = commit(context, to, plan.target as McpScopeDocument, { expectedRevision: asExpectedRevision(body) })
        if (!targetOutcome.ok) {
          send(response, 200, { ok: false, error: targetOutcome.message, issues: targetOutcome.issues })
          return
        }
        if (plan.source !== undefined) {
          const sourceOutcome = commit(runtime.context(), from, plan.source)
          if (!sourceOutcome.ok) {
            send(response, 200, { ok: false, error: `目标已写入，但来源未能清理：${sourceOutcome.message}` })
            return
          }
        }
        await runtime.remount()
        send(response, 200, { ok: true, message: plan.message, health: await runtime.healthPass({ force: true }) })
      },
    },

    // ---- Health --------------------------------------------------------------
    {
      path: HEALTH_ROUTE,
      methods: ['GET', 'POST'],
      handle: async (request, response, url) => {
        const force = url.searchParams.get('force') === '1' || request.method === 'POST'
        const scope = url.searchParams.get('scope')
        const id = url.searchParams.get('id')
        const summary = await runtime.healthPass({ force })
        if (scope !== null && id !== null) {
          const row = (summary as { results: Array<{ id: string, scope: string }> }).results
            .find(item => item.id === id && item.scope === scope)
          send(response, 200, { ok: true, health: row ?? null })
          return
        }
        send(response, 200, { ok: true, health: summary })
      },
    },

    // ---- Credential migration -----------------------------------------------
    {
      path: `${ROUTE_PREFIX}/credentials/migrate`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        // A migration is often the step right after editing an entry, so the
        // caller may hand over the unsaved form. It replaces only the scope it
        // belongs to; the other scope still comes from disk, which keeps the
        // untouched side of the configuration intact.
        const servers = body.servers === undefined
          ? allServers(runtime.context())
          : mergeScopeServers(runtime.context(), asScope(body.scope), asServers(body.servers))
        const plan = planCredentialMigration(servers, runtime.dshHome)
        if (body.apply !== true) {
          send(response, 200, { ok: plan.ok, plan })
          return
        }
        if (!plan.ok) {
          send(response, 200, { ok: false, error: plan.message, plan })
          return
        }
        const applied = applyCredentialMigration(servers, plan)
        if (!applied.outcome.ok || applied.servers === undefined) {
          send(response, 200, { ok: false, error: applied.outcome.message, plan })
          return
        }
        const context = runtime.context()
        const globalOutcome = commit(context, 'global', {
          revision: context.global.revision,
          servers: applied.servers.global,
        })
        if (!globalOutcome.ok) {
          send(response, 200, { ok: false, error: `凭据已写入，但全局配置未保存：${globalOutcome.message}` })
          return
        }
        if (applied.servers.project.length > 0 || (context.project?.servers.length ?? 0) > 0) {
          const projectOutcome = commit(runtime.context(), 'project', {
            revision: context.project?.revision ?? 0,
            servers: applied.servers.project,
          })
          if (!projectOutcome.ok) {
            send(response, 200, { ok: false, error: `凭据已写入，但项目配置未保存：${projectOutcome.message}` })
            return
          }
        }
        await runtime.remount()
        send(response, 200, {
          ok: true,
          message: applied.outcome.message,
          added: applied.outcome.added,
          replaced: applied.outcome.replaced,
          rewrote: applied.outcome.rewrote,
          health: await runtime.healthPass({ force: true }),
        })
      },
    },

    // ---- Snapshots -----------------------------------------------------------
    {
      path: `${ROUTE_PREFIX}/snapshots`,
      methods: ['GET', 'POST'],
      handle: async (request, response, url) => {
        const context = runtime.context()
        if (request.method === 'GET') {
          const scope = asScope(url.searchParams.get('scope'), 'global')
          send(response, 200, {
            ok: true,
            scope,
            snapshots: snapshotHistory(context, scope),
          })
          return
        }
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const view = viewFor(context, scope)
        if (view === undefined) {
          send(response, 200, { ok: false, error: '当前没有打开的项目' })
          return
        }
        const label = typeof body.label === 'string' ? body.label : ''
        const meta = createSnapshot(runtime.profileDir, scope, { revision: view.revision, servers: view.servers }, { kind: 'manual', label })
        send(response, 200, meta === undefined
          ? { ok: false, error: '这次备份与上一份完全相同，没有新建' }
          : { ok: true, message: `已创建备份「${meta.label}」`, snapshot: meta })
      },
    },
    {
      path: `${ROUTE_PREFIX}/snapshots/preview`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const preview = previewScopeRestore(runtime.context(), scope, id)
        if (!preview.ok) {
          send(response, 200, { ok: false, error: preview.message })
          return
        }
        const doc = snapshotDocument(runtime.context(), scope, id)
        send(response, 200, {
          ok: true,
          meta: preview.meta,
          added: preview.added,
          removed: preview.removed,
          changed: preview.changed,
          servers: doc?.servers ?? [],
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/snapshots/restore`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        const doc = snapshotDocument(runtime.context(), scope, id)
        if (doc === undefined) {
          send(response, 200, { ok: false, error: '这份备份已经不存在了' })
          return
        }
        const outcome = commit(runtime.context(), scope, doc, { expectedRevision: asExpectedRevision(body) })
        if (!outcome.ok) {
          send(response, 200, { ok: false, error: outcome.message, issues: outcome.issues, conflicted: outcome.conflicted })
          return
        }
        await runtime.remount()
        send(response, 200, { ok: true, message: `已恢复到备份「${id}」`, health: await runtime.healthPass({ force: true }) })
      },
    },
    {
      path: `${ROUTE_PREFIX}/snapshots/delete`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const id = typeof body.id === 'string' ? body.id : ''
        if (id === '') throw new Error('缺少 id')
        send(response, 200, deleteSnapshot(runtime.profileDir, scope, id)
          ? { ok: true, message: '已删除这份备份' }
          : { ok: false, error: '这份备份已经不存在了' })
      },
    },

    // ---- Import / export -----------------------------------------------------
    {
      path: `${ROUTE_PREFIX}/import`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const scope = asScope(body.scope)
        const context = runtime.context()
        const view = viewFor(context, scope)
        if (view === undefined) {
          send(response, 200, { ok: false, error: '当前没有打开的项目' })
          return
        }
        const text = typeof body.json === 'string' ? body.json : ''
        const parsed = parseImportJson(text)
        if (!parsed.ok) {
          send(response, 200, { ok: false, stage: 'parse', error: parsed.message, issues: parsed.issues })
          return
        }
        const mode: ImportMode = body.mode === 'skip' ? 'skip' : body.mode === 'rename' ? 'rename' : 'merge'
        const merged = importIntoDocument({ revision: view.revision, servers: view.servers }, parsed.entries, mode)
        const summary = {
          added: merged.added,
          replaced: merged.replaced,
          skipped: merged.skipped,
          renamed: merged.renamed,
        }
        if (body.apply !== true) {
          send(response, 200, { ok: true, preview: true, message: parsed.message, summary, servers: merged.doc.servers, issues: parsed.issues })
          return
        }
        const outcome = commit(context, scope, merged.doc, { expectedRevision: asExpectedRevision(body) })
        if (!outcome.ok) {
          send(response, 200, { ok: false, error: outcome.message, issues: outcome.issues, conflicted: outcome.conflicted })
          return
        }
        await runtime.remount()
        send(response, 200, { ok: true, message: `已导入到${scopeLabel(scope)}`, summary, health: await runtime.healthPass({ force: true }) })
      },
    },
    {
      path: `${ROUTE_PREFIX}/export`,
      methods: ['GET'],
      handle: (request, response, url) => {
        const scope = asScope(url.searchParams.get('scope'), 'global')
        const view = viewFor(runtime.context(), scope)
        if (view === undefined) {
          send(response, 200, { ok: false, error: '当前没有打开的项目' })
          return
        }
        const out = exportRedacted({ revision: view.revision, servers: view.servers })
        send(response, 200, { ok: true, scope, json: out.json, redacted: out.redacted, count: view.servers.length })
      },
    },

    // ---- Tool discovery ------------------------------------------------------
    {
      path: `${ROUTE_PREFIX}/tools`,
      methods: ['GET'],
      handle: (request, response, url) => {
        const servers = allServers(runtime.context())
        const rows = listCachedTools(runtime.profileDir, servers)
        const query = url.searchParams.get('q') ?? ''
        const server = url.searchParams.get('server') ?? ''
        const scope = url.searchParams.get('scope')
        const limit = Number(url.searchParams.get('limit') ?? '')
        const filtered = searchCachedTools(rows, {
          query,
          server,
          scope: scope === 'project' || scope === 'global' ? scope : undefined,
          limit: Number.isFinite(limit) && limit > 0 ? limit : Math.max(TOOL_SEARCH_LIMIT, rows.length),
        })
        send(response, 200, {
          ok: true,
          total: rows.length,
          count: filtered.length,
          servers: summarizeToolServers(rows),
          tools: filtered.map(toolRow),
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/tools/detail`,
      methods: ['GET'],
      handle: (request, response, url) => {
        const name = url.searchParams.get('name') ?? ''
        if (name === '') throw new Error('缺少 name')
        const servers = allServers(runtime.context())
        const rows = listCachedTools(runtime.profileDir, servers)
        const found = findCachedTool(rows, {
          name,
          server: url.searchParams.get('server') ?? undefined,
          scope: url.searchParams.get('scope') === 'project' ? 'project' : url.searchParams.get('scope') === 'global' ? 'global' : undefined,
        })
        if (!found.ok) {
          send(response, 200, found.reason === 'missing'
            ? { ok: false, error: `没有找到名为「${name}」的工具缓存，先点「重新发现」` }
            : { ok: false, error: `有多个服务器提供「${name}」，请指定 server`, candidates: found.candidates.map(toolRow) })
          return
        }
        send(response, 200, {
          ok: true,
          tool: {
            ...toolRow(found.tool),
            inputSchema: found.tool.inputSchema ?? null,
            publicName: publicToolName(found.tool.server, found.tool.name) ?? null,
          },
        })
      },
    },
    {
      path: `${ROUTE_PREFIX}/tools/refresh`,
      methods: ['POST'],
      handle: async (request, response) => {
        const body = asRecord(await readJson(request))
        const servers = allServers(runtime.context())
        const wanted = typeof body.id === 'string' && body.id !== '' ? body.id : ''
        const scope = body.scope === 'project' || body.scope === 'global' ? body.scope : undefined
        const matched = servers.filter(server => (
          (wanted === '' || server.id === wanted) && (scope === undefined || server.scope === scope)
        ))
        if (matched.length === 0) {
          send(response, 200, { ok: false, error: '没有匹配的服务器' })
          return
        }
        // A local process is spawned and owned by the Host, so this process can
        // neither call it nor list its tools; saying so beats a fake failure.
        const local = matched.filter(server => server.transport === 'stdio')
        const targets = matched.filter(server => server.transport !== 'stdio')
        const results: Array<Record<string, unknown>> = []
        for (const server of targets) {
          const outcome = await refreshTools(runtime.profileDir, server)
          results.push({ id: server.id, scope: server.scope, ok: outcome.ok, message: outcome.message, toolCount: outcome.tools?.length })
        }
        const failed = results.filter(row => row.ok !== true)
        const skippedNote = local.length === 0 ? '' : `；${String(local.length)} 个本地进程由 DSH 启动，无法在此发现工具`
        send(response, 200, {
          ok: failed.length === 0,
          message: (failed.length === 0
            ? `已刷新 ${String(results.length)} 个服务器的工具`
            : `${String(failed.length)} 个服务器刷新失败`) + skippedNote,
          skipped: local.map(server => ({ id: server.id, scope: server.scope })),
          results,
        })
      },
    },
  ]
}

/**
 * Reduce one cached tool to the row the list renders.
 * @param tool - cached tool.
 * @returns the row.
 */
function toolRow(tool: CachedTool): Record<string, unknown> {
  return {
    name: tool.name,
    title: tool.title ?? null,
    description: tool.description ?? null,
    server: tool.server,
    serverName: tool.serverName,
    scope: tool.scope,
    fetchedAt: tool.fetchedAt,
    publicName: publicToolName(tool.server, tool.name) ?? null,
  }
}

/**
 * Count cached tools per server.
 * @param tools - cached rows.
 * @returns one summary per server that has a cache.
 */
function summarizeToolServers(tools: readonly CachedTool[]): Array<Record<string, unknown>> {
  const byKey = new Map<string, { id: string, name: string, scope: McpScope, count: number, fetchedAt: string }>()
  for (const tool of tools) {
    const key = `${tool.scope}:${tool.server}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, { id: tool.server, name: tool.serverName, scope: tool.scope, count: 1, fetchedAt: tool.fetchedAt })
      continue
    }
    existing.count += 1
    if (tool.fetchedAt > existing.fetchedAt) existing.fetchedAt = tool.fetchedAt
  }
  return [...byKey.values()]
}

/**
 * Register every MCP route on the Host's HTTP server.
 *
 * Registration is wrapped in an effect so unloading the plugin takes the routes
 * down with it.
 * @param host - host context carrying the `webServer` service.
 * @param runtime - Host services the routes call into.
 */
export function registerRoutes(host: Context, runtime: McpRuntime): void {
  for (const route of routes(runtime)) {
    host.effect(() => host.webServer.register({
      kind: 'exact',
      path: route.path,
      handler: async (request, response) => {
        const url = new URL(request.url ?? route.path, 'http://127.0.0.1')
        if (!route.methods.includes(request.method ?? 'GET')) {
          response.writeHead(405, { allow: route.methods.join(', ') })
          response.end()
          return
        }
        try {
          await route.handle(request, response, url)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          runtime.warn('route %s failed: %s', route.path, message)
          if (!response.headersSent) send(response, 400, { ok: false, error: message })
          else response.end()
        }
      },
    }), `dsh-sidebar: ${route.path}`)
  }
}


