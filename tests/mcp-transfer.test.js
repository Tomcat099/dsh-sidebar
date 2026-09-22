import assert from 'node:assert/strict'
import test from 'node:test'
import { exportRedacted, importIntoDocument, parseImportJson } from '../lib/mcp/transfer.js'

test('reads the mcpServers shape every other client writes', () => {
  const out = parseImportJson(JSON.stringify({
    mcpServers: {
      gh: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
      web: { url: 'https://mcp.example.com/mcp', headers: { 'X-MCP-Toolsets': 'repos' } },
    },
  }))
  assert.equal(out.ok, true)
  assert.equal(out.entries.length, 2)
  const gh = out.entries.find(entry => entry.id === 'gh')
  assert.equal(gh.transport, 'stdio')
  assert.deepEqual(gh.args, ['-y', '@modelcontextprotocol/server-github'])
  assert.deepEqual(gh.envEnv, { GITHUB_TOKEN: 'GITHUB_TOKEN' })
  assert.equal(gh.env, undefined)
  const web = out.entries.find(entry => entry.id === 'web')
  assert.equal(web.transport, 'streamable-http')
  assert.deepEqual(web.headers, { 'X-MCP-Toolsets': 'repos' })
})

test('normalizes an sse declaration and honours the disabled flag', () => {
  const out = parseImportJson(JSON.stringify({
    mcpServers: { old: { type: 'sse', url: 'https://x/mcp', disabled: true } },
  }))
  assert.equal(out.entries[0].transport, 'streamable-http')
  assert.equal(out.entries[0].enabled, false)
})

test('accepts a bare array and a single-connection object', () => {
  const array = parseImportJson(JSON.stringify([{ name: 'one', url: 'https://a/mcp' }]))
  assert.equal(array.entries[0].id, 'one')
  const single = parseImportJson(JSON.stringify({ name: 'solo', url: 'https://b/mcp' }))
  assert.equal(single.entries[0].id, 'solo')
})

test('rejects the whole document when one entry is unusable', () => {
  const out = parseImportJson(JSON.stringify({
    mcpServers: {
      good: { url: 'https://a/mcp' },
      bad: { command: 'npx', transport: 'carrier-pigeon' },
    },
  }))
  assert.equal(out.ok, false)
  assert.equal(out.entries.length, 0)
  assert.match(out.message, /整体拒绝/u)
})

test('imports a plaintext credential without comment', () => {
  const out = parseImportJson(JSON.stringify({
    mcpServers: { leaky: { url: 'https://a/mcp', headers: { Authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345' } } },
  }))
  assert.equal(out.ok, true)
  assert.deepEqual(out.issues, [])
  assert.equal(out.entries[0].headers.Authorization, 'Bearer abcdefghijklmnopqrstuvwxyz012345')
})

test('reports what is not JSON and what has no servers', () => {
  assert.equal(parseImportJson('{oops').ok, false)
  assert.equal(parseImportJson('{"mcpServers":{}}').ok, false)
  assert.equal(parseImportJson('   ').ok, false)
})

test('merges, skips, or renames colliding ids', () => {
  const existing = {
    revision: 3,
    servers: [{ id: 'gh', enabled: true, transport: 'stdio', command: 'old' }],
  }
  const entries = [{ id: 'gh', enabled: true, transport: 'stdio', command: 'new' }]
  assert.deepEqual(importIntoDocument(existing, entries, 'merge').replaced, 1)
  assert.equal(importIntoDocument(existing, entries, 'merge').doc.servers[0].command, 'new')
  assert.equal(importIntoDocument(existing, entries, 'skip').skipped, 1)
  assert.equal(importIntoDocument(existing, entries, 'skip').doc.servers[0].command, 'old')
  const renamed = importIntoDocument(existing, entries, 'rename')
  assert.equal(renamed.renamed, 1)
  assert.equal(renamed.doc.servers[1].id, 'gh-2')
})

test('export keeps structure and hides every literal credential', () => {
  const out = exportRedacted({
    revision: 1,
    servers: [
      {
        id: 'web',
        enabled: true,
        transport: 'streamable-http',
        url: 'https://mcp.example.com/mcp?api_key=zzz',
        headers: { 'X-MCP-Toolsets': 'repos' },
        headerEnv: { Authorization: 'MCP_AUTH_TOKEN' },
      },
      {
        id: 'local',
        enabled: true,
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'pkg'],
        cwd: '/Users/someone/secret-project',
        env: { API_KEY: 'sk-abcdefghijklmnopqrstuvwxyz' },
        envEnv: { GITHUB_TOKEN: 'GITHUB_TOKEN' },
      },
    ],
  })
  const parsed = JSON.parse(out.json)
  assert.equal(parsed.mcpServers.web.headers['X-MCP-Toolsets'], '<REDACTED>')
  assert.equal(parsed.mcpServers.web.url.includes('zzz'), false)
  assert.equal(parsed.mcpServers.web.headerEnv.Authorization, 'MCP_AUTH_TOKEN')
  assert.equal(parsed.mcpServers.local.env.API_KEY, '<REDACTED>')
  assert.equal(parsed.mcpServers.local.envEnv.GITHUB_TOKEN, 'GITHUB_TOKEN')
  assert.equal('cwd' in parsed.mcpServers.local, false)
  assert.ok(out.redacted >= 3)
  assert.equal(out.json.includes('sk-abcdefghijklmnopqrstuvwxyz'), false)
})

test('a redacted export round-trips back into an importable document', () => {
  const exported = exportRedacted({
    revision: 0,
    servers: [{
      id: 'web',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://mcp.example.com/mcp',
      headerEnv: { Authorization: 'MCP_AUTH_TOKEN' },
    }],
  })
  const out = parseImportJson(exported.json)
  assert.equal(out.ok, true)
  assert.deepEqual(out.entries[0].headerEnv, { Authorization: 'MCP_AUTH_TOKEN' })
})
