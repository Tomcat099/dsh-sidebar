/**
 * Host half of the MCP configuration feature.
 *
 * Two responsibilities, kept apart on purpose:
 *
 * 1. **Mounting.** Each enabled entry becomes its own `dsh-mcp-client` subtree,
 *    built from a generated include file. Saving rebuilds the set without a
 *    host restart.
 * 2. **Observing.** Health is decided by actually speaking to the server (see
 *    {@link probe}), or — for `stdio` entries, whose process belongs to the
 *    Host — by asking the Host whether it registered the tools. When neither is
 *    possible the entry stays `unknown`; nothing here guesses.
 *
 * The routes live in `routes.ts`; this file owns lifecycle and state.
 */

import type { Context } from '@deepseek-ai/cordis'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isJustChatPath } from '../nav.js'
import { pruneToolCache } from './catalog.js'
import { HEALTH_SWEEP_INTERVAL_MS } from './constants.js'
import type { HealthSummary } from './diagnostics.js'
import { HealthStore, ensureHealth, type HealthPassOptions } from './health.js'
import { resolveDshHome, resolveProfileDir, scratchDir } from './paths.js'
import type { ProbeResult } from './probe.js'
import type { McpRuntime } from './routes.js'
import { registerRoutes } from './routes.js'
import { allServers, mountableServers, readContext, type ScopeContext } from './scope.js'
import type { ScopedServer } from './schema.js'
import { renderStandaloneEntry, stripManagedBlock } from './store.js'

/** One live mount, tracked so a rebuild can dispose the previous subtree. */
interface MountedTree {
  /** Cache key this subtree serves. */
  key: string
  /** Disposer released on replacement or unload. */
  dispose: () => Promise<void> | void
}

/**
 * Load the vendored include plugin through the profile's dependency graph.
 * @param profileDir - absolute profile directory.
 * @returns the include plugin's `Include` export.
 */
async function loadInclude(profileDir: string): Promise<unknown> {
  const entry = join(profileDir, 'package.json')
  const { createRequire } = await import('node:module')
  const require = createRequire(pathToFileURL(entry).href)
  const resolved = require.resolve('@deepseek-ai/cordis-plugin-include')
  const loaded = await import(pathToFileURL(resolved).href) as { Include?: unknown }
  if (loaded.Include === undefined) throw new Error('cordis-plugin-include 未导出 Include')
  return loaded.Include
}

/**
 * Key one entry across both scopes.
 * @param entry - entry to key.
 * @returns the cache key.
 */
function keyOf(entry: Pick<ScopedServer, 'id' | 'scope'>): string {
  return `${entry.scope}:${entry.id}`
}

/**
 * Read the workspace registry without hard-requiring the service.
 *
 * The MCP routes must come up even in a host that has no workspace registry, so
 * the lookup is best-effort and a missing service simply means "no active
 * project".
 * @param ctx - host context.
 * @returns the registry, or undefined when the service is absent.
 */
function workspaceRegistry(ctx: Context): { list(): Array<{ path?: unknown }> } | undefined {
  const candidate = ctx.get?.('workspaceRegistry')
  if (candidate === undefined || candidate === null) return undefined
  const registry = candidate as { list?: unknown }
  if (typeof registry.list !== 'function') return undefined
  return registry as { list(): Array<{ path?: unknown }> }
}

/**
 * Pick the project whose list should be active at boot.
 * @param ctx - host context.
 * @returns an absolute path, or undefined when no real project is open.
 */
function firstProjectRoot(ctx: Context): string | undefined {
  const listed = workspaceRegistry(ctx)?.list() ?? []
  for (const item of listed) {
    const path = typeof item.path === 'string' ? item.path : ''
    if (path !== '' && !isJustChatPath(path)) return path
  }
  return undefined
}

/**
 * Read the names of tools the Host has registered, when it can report them.
 *
 * The official client exposes MCP tools as `mcp__<serverName>__<tool>`; seeing
 * one of those for a `stdio` server is the only positive evidence available to
 * this process that the local process actually started.
 * @param ctx - host context.
 * @returns registered names, or undefined when the Host exposes no listing.
 */
function registeredToolNames(ctx: Context): string[] | undefined {
  const tools = ctx.get?.('tools') as Record<string, unknown> | undefined
  if (tools === undefined || tools === null) return undefined
  for (const method of ['list', 'names', 'all', 'values']) {
    const fn = tools[method]
    if (typeof fn !== 'function') continue
    try {
      const value = (fn as (this: unknown) => unknown).call(tools)
      if (Array.isArray(value)) {
        const names = value.flatMap((item) => {
          if (typeof item === 'string') return [item]
          if (typeof item === 'object' && item !== null && typeof (item as { name?: unknown }).name === 'string') {
            return [(item as { name: string }).name]
          }
          return []
        })
        return names
      }
    } catch {
      return undefined
    }
  }
  return undefined
}

/**
 * Build the observer that answers for entries this process cannot probe.
 * @param ctx - host context.
 * @returns an observer that returns undefined when it has nothing to say.
 */
function hostObserver(ctx: Context): (server: ScopedServer) => ProbeResult | undefined {
  return (server) => {
    if (server.transport !== 'stdio') return undefined
    const checkedAt = new Date().toISOString()
    const names = registeredToolNames(ctx)
    if (names === undefined) {
      return {
        id: server.id,
        ok: false,
        kind: 'host-status-unavailable',
        message: '当前 DSH 不提供工具注册状态查询，无法确认这个本地进程是否可用',
        checkedAt,
      }
    }
    const prefix = `mcp__${server.id}__`
    const matched = names.filter(name => name.startsWith(prefix))
    if (matched.length === 0) {
      return {
        id: server.id,
        ok: false,
        kind: 'host-tools-pending',
        message: 'Host 还没有注册这个服务器的工具；可用性确认前保持「状态未知」',
        checkedAt,
      }
    }
    return {
      id: server.id,
      ok: true,
      kind: 'connected',
      message: `Host 已注册 ${String(matched.length)} 个工具`,
      checkedAt,
      tools: matched.map(name => ({ name: name.slice(prefix.length) })),
    }
  }
}

/**
 * Mount one entry as its own live subtree.
 * @param host - host context owning the subtree.
 * @param profileDir - profile directory whose scratch area holds the mount list.
 * @param entry - the single enabled entry to mount.
 * @param sequence - monotonically increasing id keeping mount files distinct.
 * @returns the mounted subtree handle.
 */
async function mountOne(
  host: Context,
  profileDir: string,
  entry: ScopedServer,
  sequence: number,
): Promise<MountedTree> {
  const file = join(scratchDir(profileDir), `mount-${String(sequence)}.yml`)
  writeFileSync(file, `${renderStandaloneEntry(entry)}\n`, 'utf8')
  const Include = await loadInclude(profileDir)
  const handle = host.plugin(Include, { path: pathToFileURL(file).href })
  await handle.await()
  return { key: keyOf(entry), dispose: () => handle.dispose() }
}

/**
 * Register the MCP routes and keep live mounts in step with the saved lists.
 * @param ctx - host context.
 */
export function applyMcp(ctx: Context): void {
  ctx.inject(['webServer'], (host) => {
    const profileDir = resolveProfileDir()
    const dshHome = resolveDshHome()
    mkdirSync(scratchDir(profileDir), { recursive: true, mode: 0o700 })

    const health = new HealthStore()
    const live = new Map<string, MountedTree>()
    let sequence = 0
    let activeProjectRoot = firstProjectRoot(host)
    let mountedSignature = ''

    /**
     * Load both scopes for the currently active project.
     * @returns the context.
     */
    const context = (): ScopeContext => readContext(profileDir, activeProjectRoot)

    /**
     * Dispose every live subtree.
     * @returns a promise that settles once all subtrees are down.
     */
    const unmountAll = async (): Promise<void> => {
      const trees = [...live.values()]
      live.clear()
      mountedSignature = ''
      for (const tree of trees) await tree.dispose()
    }

    /**
     * Bring the mounted set in step with the configuration.
     *
     * A changed configuration rebuilds everything. An unchanged one only tries
     * the entries that are still missing: the sweep fires every interval, so
     * full rebuilds on a stable configuration would churn every healthy mount
     * just because one broken entry keeps `live` short of `wanted`.
     * @returns a promise that settles once the set matches, or only lacks entries that just failed again.
     */
    const remount = async (): Promise<void> => {
      const wanted = mountableServers(context())
      const signature = JSON.stringify(wanted.map(entry => [keyOf(entry), renderStandaloneEntry(entry)]))
      if (signature !== mountedSignature) {
        await unmountAll()
        // A server that just disappeared must not leave its tool listing behind,
        // or the tools page would advertise capabilities nobody can call.
        try {
          pruneToolCache(profileDir, allServers(context()))
        } catch (error) {
          host.logger.warn(
            'dsh-sidebar: MCP tool-cache prune failed: %s',
            error instanceof Error ? error.message : String(error),
          )
        }
        for (const entry of wanted) {
          try {
            live.set(keyOf(entry), await mountOne(host, profileDir, entry, sequence))
            sequence += 1
          } catch (error) {
            host.logger.warn(
              'dsh-sidebar: MCP server "%s" failed to mount: %s',
              entry.id,
              error instanceof Error ? error.message : String(error),
            )
          }
        }
        mountedSignature = signature
        return
      }
      for (const entry of wanted) {
        if (live.has(keyOf(entry))) continue
        try {
          live.set(keyOf(entry), await mountOne(host, profileDir, entry, sequence))
          sequence += 1
        } catch (error) {
          host.logger.warn(
            'dsh-sidebar: MCP server "%s" failed to mount again: %s',
            entry.id,
            error instanceof Error ? error.message : String(error),
          )
        }
      }
    }

    /**
     * Run a health pass over every configured entry.
     * @param options - forcing, observer, and probe settings.
     * @returns the summary produced.
     */
    const healthPass = async (options: HealthPassOptions): Promise<HealthSummary> => {
      const pass = await ensureHealth(health, allServers(context()), {
        observe: hostObserver(host),
        ...options,
      })
      return pass.summary
    }

    const runtime: McpRuntime = {
      profileDir,
      dshHome,
      activeProjectRoot: () => activeProjectRoot,
      setActiveProjectRoot: (root) => {
        if (root === activeProjectRoot) return
        activeProjectRoot = root
        health.clear()
      },
      context,
      healthPass,
      remount,
      warn: (message, ...args) => { host.logger.warn(message, ...args) },
    }

    host.effect(() => () => { void unmountAll() }, 'dsh-sidebar: mcp mounts')

    registerRoutes(host, runtime)

    host.effect(() => {
      let cancelled = false
      void (async () => {
        if (stripManagedBlock(profileDir)) {
          host.logger.warn('dsh-sidebar: removed leftover MCP managed block from cordis.patch.yml')
        }
        await remount()
        if (cancelled) return
        const summary = await healthPass({})
        for (const row of summary.results) {
          if (!row.ok && row.state !== 'unknown' && row.state !== 'disabled') {
            host.logger.warn('dsh-sidebar: MCP server "%s": %s', row.id, row.message)
          }
        }
      })()
      return () => { cancelled = true }
    }, 'dsh-sidebar: mcp bootstrap')

    // Expired verdicts are re-checked in the background so the page opens with
    // current numbers instead of a stale green dot.
    host.effect(() => {
      const timer = setInterval(() => {
        void (async () => {
          try {
            await remount()
            await healthPass({})
          } catch (error) {
            host.logger.warn(
              'dsh-sidebar: MCP health sweep failed: %s',
              error instanceof Error ? error.message : String(error),
            )
          }
        })()
      }, HEALTH_SWEEP_INTERVAL_MS)
      if (typeof timer.unref === 'function') timer.unref()
      return () => { clearInterval(timer) }
    }, 'dsh-sidebar: mcp sweep')
  })
}
