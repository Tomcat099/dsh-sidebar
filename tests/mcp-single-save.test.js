import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CONNECTION_STATE_LABELS, disabledDiagnostic, healthRow, summarize } from '../lib/mcp/diagnostics.js'
import { registerRoutes, scopedSummary } from '../lib/mcp/routes.js'
import { readContext } from '../lib/mcp/scope.js'

const ENTRY = {
  id: 'pgsql-vector',
  enabled: true,
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8091/pgsql-vector',
}

/**
 * One handshake outcome.
 * @param {boolean} ok - whether it succeeded.
 * @param {string} message - what to report.
 * @returns {object} the probe result shape.
 */
function result(ok, message) {
  return { ok, kind: ok ? 'connected' : 'refused', message, checkedAt: new Date(0).toISOString() }
}

/**
 * Stand up the route table against a throwaway profile.
 *
 * The probe is stubbed, because what is under test is the *ordering* of write
 * and check, not the transport: does the entry survive a failed handshake.
 * @param {Record<string, object>} results - handshake outcome per server id.
 * @returns {{ table: Map, readBack: Function, remounts: Function }} the harness.
 */
function harness(results) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-mcp-single-'))
  let remounts = 0
  const runtime = {
    profileDir,
    dshHome: profileDir,
    activeProjectRoot: () => undefined,
    setActiveProjectRoot: () => {},
    context: () => readContext(profileDir, undefined),
    healthPass: async (options) => {
      const rows = (options.only ?? []).map((server) => {
        if (server.enabled !== true) {
          return { ...disabledDiagnostic(new Date(0).toISOString()), id: server.id, name: server.id, label: '已停用', scope: server.scope, transport: server.transport, enabled: false, endpoint: '', ok: false }
        }
        return healthRow(server, results[server.id] ?? result(true, '握手成功'))
      })
      return summarize(rows)
    },
    remount: async () => { remounts += 1 },
    warn: () => {},
  }
  const table = new Map()
  registerRoutes(
    { effect: (fn) => { fn() }, webServer: { register: (spec) => { table.set(spec.path, spec) } } },
    runtime,
  )
  return {
    table,
    remounts: () => remounts,
    readBack: () => readContext(profileDir, undefined).global.servers,
  }
}

/**
 * Call one route the way the browser would.
 * @param {Map} table - route table.
 * @param {string} path - route path.
 * @param {object} body - request body.
 * @returns {Promise<object>} the parsed payload.
 */
async function post(table, path, body) {
  const spec = table.get(path)
  if (spec === undefined) throw new Error(`没有路由 ${path}`)
  let written = ''
  const response = { writeHead: () => {}, end: (text) => { written = String(text ?? '') } }
  const request = {
    method: 'POST',
    url: path,
    [Symbol.asyncIterator]: async function* generator() { yield Buffer.from(JSON.stringify(body)) },
  }
  await spec.handler(request, response, undefined)
  return JSON.parse(written)
}

test('a failed handshake still leaves the entry saved', async () => {
  const { table, readBack } = harness({ 'pgsql-vector': result(false, '连接被拒绝') })
  const out = await post(table, '/mcp-settings/server/save', { scope: 'global', server: ENTRY })

  assert.equal(out.ok, true, out.error)
  assert.equal(out.connected, false)
  assert.equal(out.check.ok, false)
  assert.equal(out.check.state, 'unavailable')
  assert.match(out.message, /^已保存，连接失败/)

  // The point of the whole flow: a down server must not cost the user their edit.
  const saved = readBack()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].id, 'pgsql-vector')
})

test('a working handshake reports 已保存 · 连接成功', async () => {
  const { table } = harness({ 'pgsql-vector': result(true, '握手成功') })
  const out = await post(table, '/mcp-settings/server/save', { scope: 'global', server: ENTRY })

  assert.equal(out.ok, true)
  assert.equal(out.connected, true)
  assert.equal(out.check.state, 'healthy')
  assert.equal(out.message, '已保存 · 连接成功')
})

test('saving the same id twice replaces rather than appends', async () => {
  const { table, readBack } = harness({ 'pgsql-vector': result(true, '握手成功') })
  await post(table, '/mcp-settings/server/save', { scope: 'global', server: ENTRY })
  await post(table, '/mcp-settings/server/save', {
    scope: 'global',
    server: { ...ENTRY, name: '改名之后' },
  })

  const saved = readBack()
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, '改名之后')
})

test('an invalid entry is rejected without touching disk', async () => {
  const { table, readBack } = harness({})
  const out = await post(table, '/mcp-settings/server/save', {
    scope: 'global',
    server: { id: 'bad', enabled: true, transport: 'streamable-http', url: 'http://example.com/mcp' },
  })

  assert.equal(out.ok, false)
  assert.equal(out.stage, 'validate')
  assert.equal(readBack().length, 0)
})

test('switching an entry off writes it down and reports 已停用', async () => {
  const { table, readBack } = harness({ 'pgsql-vector': result(true, '握手成功') })
  await post(table, '/mcp-settings/server/save', { scope: 'global', server: ENTRY })

  const out = await post(table, '/mcp-settings/server/enable', {
    scope: 'global',
    id: 'pgsql-vector',
    enabled: false,
  })

  assert.equal(out.ok, true)
  assert.equal(out.message, '已保存 · 已停用')
  assert.equal(readBack()[0].enabled, false)
})

test('deleting removes the entry and not its neighbours', async () => {
  const { table, readBack } = harness({})
  await post(table, '/mcp-settings/server/save', { scope: 'global', server: ENTRY })
  await post(table, '/mcp-settings/server/save', {
    scope: 'global',
    server: { ...ENTRY, id: 'other' },
  })

  const out = await post(table, '/mcp-settings/server/delete', { scope: 'global', id: 'pgsql-vector' })

  assert.equal(out.ok, true)
  assert.deepEqual(readBack().map(entry => entry.id), ['other'])
})

test('every write remounts, so a saved entry is mounted without another step', async () => {
  const { table, remounts } = harness({ 'pgsql-vector': result(true, '握手成功') })
  await post(table, '/mcp-settings/server/save', { scope: 'global', server: ENTRY })
  assert.equal(remounts(), 1)
  await post(table, '/mcp-settings/server/enable', { scope: 'global', id: 'pgsql-vector', enabled: false })
  assert.equal(remounts(), 2)
})

test('the summary is scoped to the list the page is showing', () => {
  // The store holds both scopes; a failing entry in the other scope must not
  // make a fully green list read as 部分异常.
  const rows = [
    healthRow({ ...ENTRY, scope: 'global' }, result(true, '握手成功')),
    healthRow({ ...ENTRY, id: 'other', scope: 'project' }, result(false, '连接被拒绝')),
  ]
  const everywhere = summarize(rows)

  assert.equal(everywhere.label, '部分异常')
  assert.equal(scopedSummary(everywhere, 'global').label, '已连接')
  assert.equal(scopedSummary(everywhere, 'global').failed, 0)
  assert.equal(scopedSummary(everywhere, 'project').label, CONNECTION_STATE_LABELS.unavailable)
})
