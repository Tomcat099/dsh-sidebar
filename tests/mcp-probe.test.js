import assert from 'node:assert/strict'
import test from 'node:test'
import { probeEntries, probeEntry, probeHttp } from '../lib/mcp/probe.js'

/** Build a JSON response the way a streamable-http server would. */
function json(body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

/** Initialize result a well-behaved server returns. */
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  result: { protocolVersion: '2025-06-18', serverInfo: { name: 'demo', version: '1.0' }, capabilities: {} },
}

/**
 * Build a fake fetch that answers the handshake and records what was sent.
 * @param overrides - per-method replacements, keyed by JSON-RPC method.
 * @returns the fetch function plus the recorded calls.
 */
function fakeFetch(overrides = {}) {
  const calls = []
  const impl = async (url, init) => {
    const payload = JSON.parse(init.body)
    calls.push({ url, payload, headers: init.headers })
    const override = overrides[payload.method]
    if (override !== undefined) return override(payload, init)
    if (payload.method === 'initialize') {
      return json(INITIALIZE, { 'mcp-session-id': 'sess-1' })
    }
    if (payload.method === 'notifications/initialized') return new Response('', { status: 202 })
    if (payload.method === 'tools/list') {
      return json({
        jsonrpc: '2.0',
        id: payload.id,
        result: { tools: [{ name: 'search', description: 'find things' }, { name: 'write' }] },
      })
    }
    throw new Error(`unexpected method ${String(payload.method)}`)
  }
  return { impl, calls }
}

const entry = { id: 'demo', enabled: true, transport: 'streamable-http', url: 'https://x/mcp' }

test('completes the handshake and lists tools, echoing the session id', async () => {
  const { impl, calls } = fakeFetch()
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(result.kind, 'connected')
  assert.equal(result.tools.length, 2)
  assert.equal(result.protocolVersion, '2025-06-18')
  assert.equal(result.serverInfo.name, 'demo')
  assert.equal(calls.length, 3)
  assert.equal(calls[2].headers['mcp-session-id'], 'sess-1')
})

test('reads an event-stream reply, which some servers use for one response', async () => {
  const impl = async (url, init) => {
    const payload = JSON.parse(init.body)
    if (payload.method === 'initialize') {
      return new Response(`event: message\ndata: ${JSON.stringify(INITIALIZE)}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    }
    if (payload.method === 'notifications/initialized') return new Response('', { status: 202 })
    return new Response(`data: ${JSON.stringify({ jsonrpc: '2.0', id: payload.id, result: { tools: [] } })}\n\n`, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.ok, true)
  assert.equal(result.tools.length, 0)
})

test('reports a refused credential as auth, which the health store treats as a pause', async () => {
  const impl = async () => new Response('nope', { status: 401 })
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'auth')
})

test('reports throttling with the delay the server asked for', async () => {
  const impl = async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } })
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.kind, 'rate-limit')
  assert.equal(result.retryAfterMs, 2000)
})

test('refuses an oversized body before downloading it', async () => {
  const impl = async () => new Response('x', {
    status: 200,
    headers: { 'content-type': 'application/json', 'content-length': String(4 * 1024 * 1024) },
  })
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'protocol')
  assert.match(result.message, /响应过大/u)
})

test('stops reading a body that lies about its length', async () => {
  const chunk = new Uint8Array(1024 * 1024).fill(120)
  const stream = new ReadableStream({
    start(controller) {
      for (let i = 0; i < 5; i += 1) controller.enqueue(chunk)
      controller.close()
    },
  })
  const impl = async () => new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } })
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.kind, 'protocol')
  assert.match(result.message, /上限/u)
})

test('rejects a reachable endpoint that does not speak MCP', async () => {
  const impl = async () => json({ hello: 'world' })
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.kind, 'protocol')
})

test('distinguishes a failed tool listing from a failed handshake', async () => {
  const { impl } = fakeFetch({
    'tools/list': (payload) => json({ jsonrpc: '2.0', id: payload.id, error: { code: -32601, message: 'no tools here' } }),
  })
  const result = await probeHttp(entry, { fetchImpl: impl })
  assert.equal(result.kind, 'tool-list')
})

test('asks for the credential instead of sending an empty header', async () => {
  const impl = async () => {
    throw new Error('must not be called')
  }
  const result = await probeHttp(
    { ...entry, headerEnv: { Authorization: 'MCP_SIDEBAR_TEST_UNSET' } },
    { fetchImpl: impl },
  )
  assert.equal(result.kind, 'authorization-required')
  assert.match(result.message, /MCP_SIDEBAR_TEST_UNSET/u)
})

test('classifies DNS and TLS failures from the error chain', async () => {
  const dns = await probeHttp(entry, {
    fetchImpl: async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND host'), { name: 'TypeError' }) },
  })
  assert.equal(dns.kind, 'dns')
  const tls = await probeHttp(entry, {
    fetchImpl: async () => { throw new Error('self-signed certificate in certificate chain') },
  })
  assert.equal(tls.kind, 'tls')
  const refused = await probeHttp(entry, {
    fetchImpl: async () => { throw new Error('connect ECONNREFUSED 127.0.0.1:9') },
  })
  assert.equal(refused.kind, 'refused')
})

test('never claims a local process works: stdio is reported as managed', async () => {
  const result = await probeEntry({ id: 'local', enabled: true, transport: 'stdio', command: 'npx' })
  assert.equal(result.ok, false)
  assert.equal(result.kind, 'managed')
})

test('probes a batch without letting one failure stop the rest', async () => {
  const { impl } = fakeFetch()
  const failing = async (url, init) => {
    if (url === 'https://bad/mcp') return new Response('no', { status: 403 })
    return impl(url, init)
  }
  const results = await probeEntries([
    { ...entry, id: 'good', url: 'https://good/mcp' },
    { ...entry, id: 'bad', url: 'https://bad/mcp' },
  ], { fetchImpl: failing, concurrency: 2 })
  assert.equal(results.size, 2)
  assert.equal(results.get('good').ok, true)
  assert.equal(results.get('bad').kind, 'auth')
})
