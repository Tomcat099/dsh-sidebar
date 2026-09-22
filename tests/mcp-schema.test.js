import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeDocument,
  findSecretLiterals,
  normalizeEntry,
  normalizeTransport,
  validateDocument,
  validateEntry,
} from '../lib/mcp/schema.js'

test('collapses every accepted transport spelling onto two values', () => {
  assert.equal(normalizeTransport('stdio'), 'stdio')
  assert.equal(normalizeTransport('STDIO'), 'stdio')
  assert.equal(normalizeTransport('sse'), 'streamable-http')
  assert.equal(normalizeTransport('streamable-http'), 'streamable-http')
  assert.equal(normalizeTransport('streamable_http'), 'streamable-http')
  assert.equal(normalizeTransport('http'), 'streamable-http')
  assert.equal(normalizeTransport('carrier-pigeon'), undefined)
  assert.equal(normalizeTransport(undefined), undefined)
})

test('rejects an id that cannot become a tool namespace', () => {
  const issues = validateEntry({ id: 'bad id', enabled: true, transport: 'streamable-http', url: 'https://x/mcp' })
  assert.equal(issues.length, 1)
  assert.equal(issues[0].code, 'id-format')
})

test('applies the URL policy through entry validation', () => {
  const base = { id: 'a', enabled: true, transport: 'streamable-http' }
  assert.equal(validateEntry({ ...base, url: 'https://x/mcp' }).length, 0)
  assert.equal(validateEntry({ ...base, url: 'ftp://x' })[0].code, 'url-scheme')
  const privateNet = validateEntry({ ...base, url: 'http://10.0.0.2/mcp' })[0]
  assert.equal(privateNet.code, 'url-private-network')
  assert.equal(privateNet.confirmable, true)
  assert.equal(
    validateEntry({ ...base, url: 'http://10.0.0.2/mcp', insecurePrivateNetwork: true }).length,
    0,
  )
})

test('demands a command for stdio and a url for http', () => {
  assert.equal(validateEntry({ id: 'a', enabled: true, transport: 'stdio' })[0].code, 'command-missing')
  assert.equal(validateEntry({ id: 'a', enabled: true, transport: 'streamable-http' })[0].code, 'url-missing')
})

test('flags a token pasted where a variable name belongs', () => {
  const issues = validateEntry({
    id: 'a',
    enabled: true,
    transport: 'streamable-http',
    url: 'https://x/mcp',
    headerEnv: { Authorization: 'ghp_abcdefghijklmnop' },
  })
  assert.ok(issues.some(issue => issue.code === 'env-ref-token'))
})

test('a plaintext credential is not a validation problem at all', () => {
  const entry = {
    id: 'a',
    enabled: true,
    transport: 'streamable-http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
  }
  // The file is the local connection record, written 0600, and the export
  // redacts it. Saving a working configuration must never be obstructed, and
  // validation must never grow noise the user has to dismiss.
  assert.deepEqual(validateEntry(entry), [])
  assert.equal(validateDocument({ revision: 0, servers: [entry] }).ok, true)
})

test('credential scanning is a separate capability used only by the migration', () => {
  const header = findSecretLiterals({
    id: 'a',
    enabled: true,
    transport: 'streamable-http',
    url: 'https://x/mcp',
    headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' },
  }).find(literal => literal.field === 'headers')
  assert.equal(header.key, 'Authorization')
  assert.equal(header.value, 'Bearer abcdefghijklmnopqrstuvwxyz012345')

  assert.ok(findSecretLiterals({
    id: 'b',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['--token', 'ghp_abcdefghijklmnopqrst'],
  }).some(literal => literal.field === 'args'))
})

test('does not treat a short ordinary header value as a secret', () => {
  const literals = findSecretLiterals({
    id: 'a',
    enabled: true,
    transport: 'streamable-http',
    url: 'https://x/mcp',
    headers: { 'X-MCP-Toolsets': 'repos,issues' },
  })
  assert.equal(literals.length, 0)
})

test('reads the legacy document shape and drops unusable rows', () => {
  const doc = decodeDocument({
    servers: [
      { id: 'keep', enabled: true, transport: 'http', url: 'https://x/mcp' },
      { id: 'no-transport' },
      'nonsense',
    ],
  })
  assert.equal(doc.servers.length, 1)
  assert.equal(doc.servers[0].id, 'keep')
  assert.equal(doc.servers[0].transport, 'streamable-http')
  assert.equal(doc.revision, 0)
})

test('detects a duplicated id across the document', () => {
  const entry = { id: 'dup', enabled: true, transport: 'streamable-http', url: 'https://x/mcp' }
  const verdict = validateDocument({ revision: 0, servers: [entry, { ...entry }] })
  assert.equal(verdict.ok, false)
  assert.ok(verdict.issues.some(issue => issue.code === 'id-duplicate'))
})

test('normalizes an imported object into a full entry', () => {
  const entry = normalizeEntry({ id: 'gh', type: 'sse', url: 'https://x/mcp', enabled: false })
  assert.deepEqual(entry, { id: 'gh', enabled: false, transport: 'streamable-http', url: 'https://x/mcp' })
})
