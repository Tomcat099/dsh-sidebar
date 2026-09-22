/**
 * HTTP surface for the settings card and the toolbox page.
 *
 * The browser never touches SQLite: it reads state, lists memories, and writes
 * through these routes, which own the provider and the settings namespace.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MemoryDraft, MemoryHealth, MemoryHit } from './types.js'
import type { MemoryConfig } from './config.js'

/** Route prefix owned by the memory feature. */
export const MEMORY_ROUTE_PREFIX = '/api/dsh-sidebar/memory'

/** Everything the routes can ask of the runtime. */
export interface MemoryApi {
  /** Resolved configuration plus backend reachability and counters. */
  state(): Promise<MemoryStatePayload>
  /** Search memories. */
  search(input: { text: string, topK: number }): Promise<MemoryHit[]>
  /** Page through memories. */
  list(input: { text: string, limit: number, offset: number }): Promise<MemoryHit[]>
  /** Store one memory. */
  write(draft: MemoryDraft): Promise<{ id: string, created: boolean }>
  /** Patch one memory. */
  update(id: string, patch: Partial<MemoryDraft>): Promise<void>
  /** Remove one memory. */
  remove(id: string): Promise<void>
  /** Merge memories that describe the same fact. */
  dedupe(): Promise<{ removed: number }>
  /** Rebuild stored vectors with the configured embedding model. */
  reembed(): Promise<{ updated: number, failed: number }>
  /** Persist a settings patch through the host settings service. */
  saveConfig(patch: Record<string, unknown>): Promise<void>
}

/** Payload of `GET /state`, also used by the browser card. */
export interface MemoryStatePayload {
  config: MemoryConfig
  /** Counters that make a silent extraction failure visible in the UI. */
  diagnostics: {
    /** Session events delivered to the fast path. */
    events: number
    /** Sweeps executed over live sessions. */
    sweeps: number
    /** Which host seams resolved; a `false` field explains a dead feature. */
    wiring: { tools: boolean, systemPrompt: boolean, agents: boolean, llm: boolean, settings: boolean }
    /** What the recall injection would send right now. */
    recall: { standingChars: number, sessions: number }
    /** Outcome of the most recent extraction pass. */
    lastExtract?: { at: number, ok: boolean, count: number, error?: string }
  }
  /** Vector length the configuration asks for and what the endpoint returns. */
  embedding: { configured: number, observed?: number }
  /** Reason the backend cannot serve requests, when there is one. */
  complaint?: string
  /** Backend reachability probe. */
  health: MemoryHealth | { ok: false, kind: 'none', detail: string }
  /** Live memory count, or `-1` when it could not be read. */
  count: number
  /** Absolute directory of the local database, when local mode is active. */
  database?: string
}

/** Routes registered by {@link registerMemoryRoutes}. */
const ROUTES: Array<{ path: string, methods: string[] }> = [
  { path: `${MEMORY_ROUTE_PREFIX}/state`, methods: ['GET'] },
  { path: `${MEMORY_ROUTE_PREFIX}/config`, methods: ['POST'] },
  { path: `${MEMORY_ROUTE_PREFIX}/list`, methods: ['GET'] },
  { path: `${MEMORY_ROUTE_PREFIX}/search`, methods: ['GET'] },
  { path: `${MEMORY_ROUTE_PREFIX}/write`, methods: ['POST'] },
  { path: `${MEMORY_ROUTE_PREFIX}/update`, methods: ['POST'] },
  { path: `${MEMORY_ROUTE_PREFIX}/remove`, methods: ['POST'] },
  { path: `${MEMORY_ROUTE_PREFIX}/dedupe`, methods: ['POST'] },
  { path: `${MEMORY_ROUTE_PREFIX}/reembed`, methods: ['POST'] },
]

/**
 * Read a non-negative integer query parameter.
 * @param params - URL search params.
 * @param key - parameter name.
 * @param fallback - value used when absent or unparsable.
 * @param max - upper clamp.
 * @returns the resolved integer.
 */
function intParam(params: URLSearchParams, key: string, fallback: number, max: number): number {
  const raw = params.get(key)
  const parsed = raw === null ? Number.NaN : Number(raw)
  if (!Number.isFinite(parsed)) return fallback
  return Math.min(max, Math.max(0, Math.trunc(parsed)))
}

/**
 * Read one string field off a JSON body.
 * @param body - parsed body.
 * @param key - field name.
 * @returns the trimmed value, or `''`.
 */
function bodyString(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read one string-array field off a JSON body.
 * @param body - parsed body.
 * @param key - field name.
 * @returns the values, empty when the field is not an array.
 */
function bodyStrings(body: unknown, key: string): string[] {
  const value = (body as Record<string, unknown> | undefined)?.[key]
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).trim()).filter((item) => item !== '')
}

/**
 * Map a thrown error onto a JSON response.
 * @param error - failure from a route.
 * @returns the response.
 */
function failure(error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error)
  return Response.json({ error: message }, { status: 400 })
}

/**
 * Register the memory routes on the host connection.
 * @param ctx - context owning the routes.
 * @param api - runtime bindings.
 */
export function registerMemoryRoutes(ctx: Context, api: MemoryApi): void {
  for (const route of ROUTES) {
    ctx.connection.fetch.register({
      path: route.path,
      methods: route.methods,
      requestBody: 'buffered',
      async fetch(request) {
        try {
          request.signal.throwIfAborted()
          const url = new URL(request.url)
          switch (route.path) {
            case `${MEMORY_ROUTE_PREFIX}/state`: {
              return Response.json(await api.state())
            }
            case `${MEMORY_ROUTE_PREFIX}/config`: {
              const body = await request.json()
              await api.saveConfig((body ?? {}) as Record<string, unknown>)
              return Response.json(await api.state())
            }
            case `${MEMORY_ROUTE_PREFIX}/list`: {
              const items = await api.list({
                text: url.searchParams.get('q') ?? '',
                limit: intParam(url.searchParams, 'limit', 50, 200),
                offset: intParam(url.searchParams, 'offset', 0, 100_000),
              })
              return Response.json({ items })
            }
            case `${MEMORY_ROUTE_PREFIX}/search`: {
              const query = url.searchParams.get('q') ?? ''
              if (query.trim() === '') return Response.json({ items: [] })
              const items = await api.search({
                text: query,
                topK: intParam(url.searchParams, 'topK', 5, 50),
              })
              return Response.json({ items })
            }
            case `${MEMORY_ROUTE_PREFIX}/write`: {
              const body = await request.json()
              const content = bodyString(body, 'content')
              if (content === '') throw new Error('内容不能为空')
              const written = await api.write({
                kind: bodyString(body, 'kind') || 'fact',
                content,
                tags: bodyStrings(body, 'tags'),
              })
              return Response.json(written)
            }
            case `${MEMORY_ROUTE_PREFIX}/update`: {
              const body = await request.json()
              const id = bodyString(body, 'id')
              if (id === '') throw new Error('缺少记忆 id')
              const draft: Partial<MemoryDraft> = {}
              if (typeof (body as Record<string, unknown>).content === 'string') draft.content = bodyString(body, 'content')
              if (typeof (body as Record<string, unknown>).kind === 'string') draft.kind = bodyString(body, 'kind')
              if (Array.isArray((body as Record<string, unknown>).tags)) draft.tags = bodyStrings(body, 'tags')
              await api.update(id, draft)
              return Response.json({ ok: true })
            }
            case `${MEMORY_ROUTE_PREFIX}/remove`: {
              const body = await request.json()
              const id = bodyString(body, 'id')
              if (id === '') throw new Error('缺少记忆 id')
              await api.remove(id)
              return Response.json({ ok: true })
            }
            case `${MEMORY_ROUTE_PREFIX}/dedupe`: {
              return Response.json(await api.dedupe())
            }
            case `${MEMORY_ROUTE_PREFIX}/reembed`: {
              return Response.json(await api.reembed())
            }
            default: {
              return Response.json({ error: '未知的记忆接口' }, { status: 404 })
            }
          }
        } catch (error) {
          return failure(error)
        }
      },
    })
  }
}
