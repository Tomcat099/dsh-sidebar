import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyCredentialMigration, deriveVariable, planCredentialMigration } from '../lib/mcp/credentials.js'
import { envFilePath, isReservedEnvName, isWritableValue, upsertEnvFile } from '../lib/mcp/env-file.js'

/** Build one throwaway DSH home. */
function sandbox() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-mcp-creds-'))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

test('refuses every name the launcher reserves', () => {
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'HTTP_PROXY', 'DSH_HOME', 'XDG_CONFIG_HOME', 'DYLD_X', 'BASH_FUNC_x']) {
    assert.equal(isReservedEnvName(name), true, name)
  }
  assert.equal(isReservedEnvName('MCP_GH_AUTHORIZATION'), false)
  assert.equal(isReservedEnvName('GITHUB_TOKEN'), false)
})

test('only writes values that need no quoting', () => {
  assert.equal(isWritableValue('ghp_abc-123.xyz~+/='), true)
  assert.equal(isWritableValue('has space'), false)
  assert.equal(isWritableValue('has"quote'), false)
  assert.equal(isWritableValue('中文'), false)
})

test('creates the file, then replaces in place and keeps foreign lines', () => {
  const box = sandbox()
  try {
    const file = envFilePath(box.home)
    const first = upsertEnvFile(file, [{ name: 'MCP_A_TOKEN', value: 'one' }])
    assert.deepEqual(first.added, ['MCP_A_TOKEN'])

    writeFileSync(file, `# my own note\nOTHER=keep\nMCP_A_TOKEN=one\n`, 'utf8')
    const second = upsertEnvFile(file, [{ name: 'MCP_A_TOKEN', value: 'two' }])
    assert.deepEqual(second.replaced, ['MCP_A_TOKEN'])
    const text = readFileSync(file, 'utf8')
    assert.match(text, /# my own note/u)
    assert.match(text, /OTHER=keep/u)
    assert.match(text, /MCP_A_TOKEN=two/u)
    assert.equal(text.includes('MCP_A_TOKEN=one'), false)
  } finally {
    box.cleanup()
  }
})

test('refuses a reserved name instead of breaking the next boot', () => {
  const box = sandbox()
  try {
    const outcome = upsertEnvFile(envFilePath(box.home), [{ name: 'DSH_HOME', value: '/tmp/x' }])
    assert.equal(outcome.refused.length, 1)
    assert.equal(outcome.added.length, 0)
  } finally {
    box.cleanup()
  }
})

test('writes the file readable only by its owner', () => {
  const box = sandbox()
  try {
    const file = envFilePath(box.home)
    upsertEnvFile(file, [{ name: 'MCP_A_TOKEN', value: 'one' }])
    assert.equal(statSync(file).mode & 0o777, 0o600)
  } finally {
    box.cleanup()
  }
})

test('derives a stable, writable variable name', () => {
  assert.equal(deriveVariable('pgsql-vector', 'Authorization'), 'MCP_PGSQL_VECTOR_AUTHORIZATION')
  assert.equal(deriveVariable('a.b', 'X-API-Key'), 'MCP_A_B_X_API_KEY')
  assert.equal(deriveVariable('x', ''), 'MCP_X_CREDENTIAL')
})

const bearer = (id, scope = 'global') => ({
  id,
  scope,
  enabled: true,
  transport: 'streamable-http',
  url: 'http://127.0.0.1:8091/x',
  headers: { Authorization: 'Bearer super-secret-token-value' },
})

test('plans a Bearer header move without carrying the secret in the plan', () => {
  const box = sandbox()
  try {
    const plan = planCredentialMigration([bearer('pgsql-vector')], box.home)
    assert.equal(plan.ok, true)
    assert.equal(plan.moves.length, 1)
    assert.equal(plan.moves[0].variable, 'MCP_PGSQL_VECTOR_AUTHORIZATION')
    assert.equal(plan.moves[0].effect, 'add')
    assert.equal(plan.moves[0].length, 'super-secret-token-value'.length)
    assert.equal(JSON.stringify(plan).includes('super-secret-token-value'), false)
  } finally {
    box.cleanup()
  }
})

test('applies the move: env file holds the bare token, entry references the variable', () => {
  const box = sandbox()
  try {
    const servers = [bearer('pgsql-vector')]
    const plan = planCredentialMigration(servers, box.home)
    const applied = applyCredentialMigration(servers, plan)
    assert.equal(applied.outcome.ok, true)
    assert.equal(readFileSync(plan.file, 'utf8').includes('MCP_PGSQL_VECTOR_AUTHORIZATION=super-secret-token-value'), true)

    const entry = applied.servers.global[0]
    assert.equal(entry.headerEnv.Authorization, 'MCP_PGSQL_VECTOR_AUTHORIZATION')
    assert.equal(entry.headers, undefined)
  } finally {
    box.cleanup()
  }
})

test('moves a stdio env literal into an envEnv reference', () => {
  const box = sandbox()
  try {
    const servers = [{
      id: 'local',
      scope: 'global',
      enabled: true,
      transport: 'stdio',
      command: 'npx',
      env: { GITHUB_TOKEN: 'ghp_abcdefghijklmnopqrst' },
    }]
    const plan = planCredentialMigration(servers, box.home)
    assert.equal(plan.moves.length, 1)
    assert.equal(plan.moves[0].field, 'env')
    const applied = applyCredentialMigration(servers, plan)
    const entry = applied.servers.global[0]
    assert.equal(entry.env, undefined)
    assert.equal(entry.envEnv.GITHUB_TOKEN, 'MCP_LOCAL_GITHUB_TOKEN')
    assert.match(readFileSync(plan.file, 'utf8'), /MCP_LOCAL_GITHUB_TOKEN=ghp_abcdefghijklmnopqrst/u)
  } finally {
    box.cleanup()
  }
})

test('refuses a non-Bearer header rather than dropping the prefix', () => {
  const box = sandbox()
  try {
    const servers = [{
      id: 'weird',
      scope: 'global',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://x/mcp',
      headers: { 'X-Api-Key': 'sk-abcdefghijklmnopqrstuv' },
    }]
    const plan = planCredentialMigration(servers, box.home)
    assert.equal(plan.ok, false)
    assert.equal(plan.refusals.length, 1)
    assert.match(plan.refusals[0].reason, /Bearer/u)
    const applied = applyCredentialMigration(servers, plan)
    assert.equal(applied.servers, undefined)
  } finally {
    box.cleanup()
  }
})

test('reports nothing to do for a clean configuration', () => {
  const box = sandbox()
  try {
    const servers = [{
      id: 'clean',
      scope: 'global',
      enabled: true,
      transport: 'streamable-http',
      url: 'https://x/mcp',
      headerEnv: { Authorization: 'MCP_CLEAN_TOKEN' },
    }]
    const plan = planCredentialMigration(servers, box.home)
    assert.equal(plan.ok, false)
    assert.equal(plan.moves.length, 0)
    assert.match(plan.message, /没有发现明文凭据/u)
  } finally {
    box.cleanup()
  }
})

test('keeps project entries in the project scope', () => {
  const box = sandbox()
  try {
    const servers = [bearer('shared', 'project')]
    const plan = planCredentialMigration(servers, box.home)
    const applied = applyCredentialMigration(servers, plan)
    assert.equal(applied.servers.project.length, 1)
    assert.equal(applied.servers.global.length, 0)
  } finally {
    box.cleanup()
  }
})
