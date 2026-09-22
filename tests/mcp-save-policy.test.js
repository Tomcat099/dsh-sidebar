import assert from 'node:assert/strict'
import test from 'node:test'
import { splitProbeTargets } from '../lib/mcp/routes.js'
import { validateDocument } from '../lib/mcp/schema.js'

const entry = (extra = {}) => ({
  id: 'a',
  enabled: true,
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  ...extra,
})

const doc = servers => ({ revision: 0, servers })

test('an unchanged server is not probed at all', () => {
  const before = doc([entry(), entry({ id: 'b', url: 'https://b/mcp' })])
  const { must, may } = splitProbeTargets(before, doc([entry(), entry({ id: 'b', url: 'https://b/mcp' })]))
  assert.equal(must.length + may.length, 0)
})

test('a new server must answer before it lands', () => {
  const { must, may } = splitProbeTargets(doc([]), doc([entry()]))
  assert.deepEqual(must.map(item => item.id), ['a'])
  assert.equal(may.length, 0)
})

test('moving where a server points must answer', () => {
  for (const moved of [{ url: 'https://other/mcp' }, { command: 'npx', transport: 'stdio' }]) {
    const { must } = splitProbeTargets(doc([entry()]), doc([entry(moved)]))
    assert.deepEqual(must.map(item => item.id), ['a'], JSON.stringify(moved))
  }
})

test('rotating a credential only warns, so a new token never blocks its own save', () => {
  const before = doc([entry({ headers: { Authorization: 'Bearer old-token-value-1234' } })])
  const after = doc([entry({ headerEnv: { Authorization: 'MCP_A_AUTHORIZATION' } })])
  const { must, may } = splitProbeTargets(before, after)
  assert.equal(must.length, 0)
  assert.deepEqual(may.map(item => item.id), ['a'])
})

test('changing only settings such as readonly or toolsets only warns', () => {
  const { must, may } = splitProbeTargets(doc([entry()]), doc([entry({ readonly: true, toolsets: 'repos' })]))
  assert.equal(must.length, 0)
  assert.deepEqual(may.map(item => item.id), ['a'])
})

test('renaming a server is not a connection change', () => {
  const { must, may } = splitProbeTargets(doc([entry()]), doc([entry({ name: 'Nice name' })]))
  assert.equal(must.length + may.length, 0)
})

test('a disabled server is never probed', () => {
  const { must, may } = splitProbeTargets(doc([]), doc([entry({ enabled: false })]))
  assert.equal(must.length + may.length, 0)
})

test('a stored plaintext credential is not reported as a problem', () => {
  const verdict = validateDocument(
    doc([entry({ headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' } })]),
  )
  assert.equal(verdict.ok, true)
  assert.deepEqual(verdict.issues, [])
})
