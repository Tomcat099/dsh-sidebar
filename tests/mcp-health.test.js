import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  cacheTools,
  findCachedTool,
  listCachedTools,
  pruneToolCache,
  publicToolName,
  readToolCache,
  searchCachedTools,
  trimSchema,
} from '../lib/mcp/catalog.js'
import {
  CONNECTION_STATE_LABELS,
  diagnosticFor,
  healthRow,
  stageOf,
  stateOfFailure,
  summarize,
  unobservedDiagnostic,
} from '../lib/mcp/diagnostics.js'
import { HealthStore, ensureHealth } from '../lib/mcp/health.js'

const server = (id, extra = {}) => ({
  id,
  scope: 'global',
  enabled: true,
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  ...extra,
})

/** A probe result with the given outcome, stamped on the test clock. */
function probe(kind, extra = {}) {
  return {
    id: 'demo',
    ok: kind === 'connected',
    kind,
    message: `${kind} happened`,
    checkedAt: new Date(clock).toISOString(),
    ...extra,
  }
}

test('maps each failure to the stage and state the UI shows', () => {
  assert.equal(stageOf('connected'), 'ready')
  assert.equal(stageOf('auth'), 'authentication')
  assert.equal(stageOf('protocol'), 'mcp-initialize')
  assert.equal(stageOf('tool-list'), 'tool-discovery')
  assert.equal(stageOf('process-not-found'), 'host-startup')
  assert.equal(stageOf('host-tools-pending'), 'host-observation')
  assert.equal(stageOf('dns'), 'transport')

  assert.equal(stateOfFailure('auth'), 'reauth')
  assert.equal(stateOfFailure('rate-limit'), 'recovering')
  assert.equal(stateOfFailure('dns'), 'unavailable')
  assert.equal(stateOfFailure('managed'), 'unknown')
})

test('every diagnostic carries a stage label and an instruction', () => {
  const diagnostic = diagnosticFor(probe('dns'))
  assert.equal(diagnostic.state, 'unavailable')
  assert.equal(diagnostic.stageLabel, '网络与传输')
  assert.ok(diagnostic.action.length > 0)
  assert.equal(diagnostic.code, 'dns')
})

test('no rows means not configured, never healthy', () => {
  const summary = summarize([])
  assert.equal(summary.connectionState, 'disconnected')
  assert.equal(summary.diagnostic.code, 'not-configured')
})

test('a working subset with failures reads as degraded', () => {
  const rows = [
    healthRow(server('ok'), probe('connected')),
    healthRow(server('bad'), probe('refused')),
  ]
  const summary = summarize(rows)
  assert.equal(summary.connectionState, 'degraded')
  assert.equal(summary.available, 1)
  assert.equal(summary.failed, 1)
  assert.equal(summary.diagnostic.code, 'refused')
})

test('an unobserved entry keeps the summary unknown rather than green', () => {
  const row = { ...unobservedDiagnostic(new Date().toISOString()), id: 'x', name: 'x', scope: 'global', transport: 'stdio', enabled: true, endpoint: 'npx', ok: false }
  const summary = summarize([row])
  assert.equal(summary.connectionState, 'unknown')
  assert.equal(summary.pending, 1)
  assert.equal(summary.available, 0)
  assert.equal(CONNECTION_STATE_LABELS.unknown, '状态未知')
})

test('every row carries its own state label', () => {
  // Regression: rows used to ship `state` without `label`, so the list rendered
  // an empty cell where the connection state belonged.
  const rows = [
    healthRow(server('a'), probe('connected')),
    healthRow(server('b'), probe('auth')),
    healthRow(server('c', { enabled: false }), probe('refused')),
  ]
  for (const row of rows) {
    assert.equal(typeof row.label, 'string')
    assert.equal(row.label, CONNECTION_STATE_LABELS[row.state])
  }
})

test('placeholder rows keep the same label contract', () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  assert.equal(store.recordDisabled(server('a', { enabled: false })).label, CONNECTION_STATE_LABELS.disabled)
  assert.equal(store.recordUnobserved(server('b')).label, CONNECTION_STATE_LABELS.unknown)
})

test('credentials failing everywhere reports reauth rather than a plain error', () => {
  const rows = [healthRow(server('a'), probe('auth')), healthRow(server('b'), probe('authorization-required'))]
  const summary = summarize(rows)
  assert.equal(summary.connectionState, 'reauth')
  assert.equal(summary.authFailures, 2)
})

test('a rate-limited entry is reported as recovering', () => {
  const summary = summarize([healthRow(server('a'), probe('rate-limit', { retryAfterMs: 5000 }))])
  assert.equal(summary.connectionState, 'recovering')
  assert.equal(summary.diagnostic.code, 'rate-limit')
})

let clock = 1_000_000
const now = () => clock

test('a fresh verdict is reused and an expired one is re-checked', () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const target = server('a')
  store.record(target, probe('connected'))
  assert.equal(store.due(target), false)
  clock += 6 * 60_000
  assert.equal(store.due(target), true)
})

test('a failure backs off instead of retrying immediately', () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const target = server('a')
  const row = store.record(target, probe('refused'))
  assert.equal(row.retryAt > clock, true)
  assert.equal(store.due(target), false)
  clock = row.retryAt
  assert.equal(store.due(target), true)
})

test('an authentication failure stops automatic retries entirely', () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const target = server('a')
  const row = store.record(target, probe('auth'))
  assert.equal(row.paused, true)
  assert.equal(store.isPaused(target), true)
  clock += 60 * 60_000
  assert.equal(store.due(target), false)
})

test('a successful check clears the pause and the backoff', () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const target = server('a')
  store.record(target, probe('auth'))
  store.record(target, probe('connected'))
  assert.equal(store.isPaused(target), false)
  assert.equal(store.due(target), false)
})

test('a local process is never auto-probed but is observed when the Host can report', async () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const local = server('local', { transport: 'stdio', command: 'npx' })
  let probed = 0
  const pass = await ensureHealth(store, [local], {
    observe: () => {
      probed += 1
      return probe('managed')
    },
    fetchImpl: async () => { throw new Error('must not be called') },
  })
  assert.equal(probed, 0)
  assert.equal(pass.summary.connectionState, 'unknown')

  const forced = await ensureHealth(store, [local], {
    force: true,
    observe: () => probe('connected', { tools: [{ name: 'a' }] }),
  })
  assert.equal(forced.summary.connectionState, 'healthy')
})

test('deferring a pass reports what is known without probing anything', async () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const pass = await ensureHealth(store, [server('a')], {
    defer: true,
    fetchImpl: async () => { throw new Error('must not be called') },
  })
  assert.equal(pass.checked.length, 0)
  assert.equal(pass.summary.pending, 1)
})

test('a disabled entry is reported as disabled, not as a failure', async () => {
  clock = 1_000_000
  const store = new HealthStore({ now })
  const pass = await ensureHealth(store, [server('a', { enabled: false })], {
    fetchImpl: async () => { throw new Error('must not be called') },
  })
  assert.equal(pass.summary.connectionState, 'disabled')
  assert.equal(pass.summary.failed, 0)
})

test('caches a listing, searches it, and forgets servers that are gone', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-catalog-'))
  try {
    const host = server('gh')
    cacheTools(root, host, [
      { name: 'list_repos', description: 'List repositories', inputSchema: { type: 'object' } },
      { name: 'create_issue', description: 'Open an issue', inputSchema: { type: 'object' } },
    ])
    const rows = listCachedTools(root, [host])
    assert.equal(rows.length, 2)
    assert.equal(rows[0].server, 'gh')

    assert.deepEqual(searchCachedTools(rows, { query: 'repos' }).map(row => row.name), ['list_repos'])
    assert.deepEqual(searchCachedTools(rows, { query: 'issue' }).map(row => row.name), ['create_issue'])
    assert.equal(searchCachedTools(rows, { query: 'nothing' }).length, 0)

    const found = findCachedTool(rows, { name: 'list_repos' })
    assert.equal(found.ok, true)
    assert.equal(findCachedTool(rows, { name: 'missing' }).reason, 'missing')

    assert.deepEqual(pruneToolCache(root, []), ['global:gh'])
    assert.equal(Object.keys(readToolCache(root).servers).length, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('reports an ambiguous tool name instead of guessing', () => {
  const rows = [
    { name: 'search', server: 'a', serverName: 'A', scope: 'global', fetchedAt: 'x' },
    { name: 'search', server: 'b', serverName: 'B', scope: 'global', fetchedAt: 'x' },
  ]
  const found = findCachedTool(rows, { name: 'search' })
  assert.equal(found.ok, false)
  assert.equal(found.reason, 'ambiguous')
  assert.equal(found.candidates.length, 2)
  assert.equal(findCachedTool(rows, { name: 'search', server: 'b' }).ok, true)
})

test('only advertises a public tool name it can be sure about', () => {
  assert.equal(publicToolName('gh', 'list_repos'), 'mcp__gh__list_repos')
  assert.equal(publicToolName('gh', 'repo.search'), undefined)
})

test('trims a remote schema so a page cannot be made unrenderable', () => {
  let deep = { type: 'string' }
  for (let i = 0; i < 10; i += 1) deep = { type: 'object', properties: { child: deep } }
  const trimmed = trimSchema(deep)
  let cursor = trimmed
  let levels = 0
  while (cursor.properties !== undefined) {
    cursor = cursor.properties.child
    levels += 1
  }
  assert.equal(levels, 6)
  assert.deepEqual(cursor, { type: 'object' })

  const wide = { properties: Object.fromEntries(Array.from({ length: 90 }, (_, i) => [`p${String(i)}`, { type: 'string' }])) }
  assert.equal(Object.keys(trimSchema(wide).properties).length, 60)

  const long = { description: 'x'.repeat(5000) }
  assert.equal(trimSchema(long).description.length, 600)

  assert.equal(trimSchema({ $defs: { huge: 'x' }, type: 'object' }).$defs, undefined)
})
