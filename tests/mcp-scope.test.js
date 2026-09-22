import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  allServers,
  commit,
  mountableServers,
  previewScopeRestore,
  projectView,
  readContext,
  snapshotDocument,
  snapshotHistory,
  transferBetween,
} from '../lib/mcp/scope.js'

/** Build one throwaway profile plus project pair. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcp-scope-'))
  const profile = join(root, 'profile')
  const project = join(root, 'project')
  return {
    profile,
    project,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  }
}

const entry = (id, extra = {}) => ({
  id,
  enabled: true,
  transport: 'streamable-http',
  url: 'https://mcp.example.com/mcp',
  ...extra,
})

test('the first commit writes the file at revision 0 and the second bumps it', () => {
  const box = sandbox()
  try {
    const first = commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a')] })
    assert.equal(first.ok, true)
    assert.equal(first.stored.revision, 0)
    const second = commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a'), entry('b')] })
    assert.equal(second.stored.revision, 1)
    const written = JSON.parse(readFileSync(join(box.profile, '.mcp-servers.json'), 'utf8'))
    assert.equal(written.servers.length, 2)
  } finally {
    box.cleanup()
  }
})

test('a stale revision is refused instead of clobbering the other write', () => {
  const box = sandbox()
  try {
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a')] })
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a'), entry('b')] })
    const outcome = commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('only')] }, { expectedRevision: 0 })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.conflicted, true)
    const written = JSON.parse(readFileSync(join(box.profile, '.mcp-servers.json'), 'utf8'))
    assert.deepEqual(written.servers.map(item => item.id), ['a', 'b'])
  } finally {
    box.cleanup()
  }
})

test('an invalid document is rejected before anything touches disk', () => {
  const box = sandbox()
  try {
    const outcome = commit(readContext(box.profile), 'global', {
      revision: 0,
      servers: [{ id: 'a', enabled: true, transport: 'streamable-http' }],
    })
    assert.equal(outcome.ok, false)
    assert.equal(outcome.snapshot, undefined)
    assert.throws(() => readFileSync(join(box.profile, '.mcp-servers.json'), 'utf8'))
  } finally {
    box.cleanup()
  }
})

test('every save leaves the previous revision recoverable', () => {
  const box = sandbox()
  try {
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a')] })
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a'), entry('b')] })
    const history = snapshotHistory(readContext(box.profile), 'global')
    assert.equal(history.length, 1)
    assert.equal(history[0].kind, 'auto')
    assert.equal(history[0].serverCount, 1)

    const preview = previewScopeRestore(readContext(box.profile), 'global', history[0].id)
    assert.equal(preview.ok, true)
    assert.deepEqual(preview.removed, ['b'])

    const restored = snapshotDocument(readContext(box.profile), 'global', history[0].id)
    const outcome = commit(readContext(box.profile), 'global', restored)
    assert.equal(outcome.ok, true)
    assert.deepEqual(readContext(box.profile).global.servers.map(item => item.id), ['a'])
  } finally {
    box.cleanup()
  }
})

test('the project scope overrides a global entry with the same id', () => {
  const box = sandbox()
  try {
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('shared', { url: 'https://global/mcp' })] })
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('solo')] })
    const contextWithProject = readContext(box.profile, box.project)
    commit(contextWithProject, 'project', { revision: 0, servers: [entry('shared', { url: 'https://project/mcp' })] })

    const context = readContext(box.profile, box.project)
    assert.equal(context.project.root, box.project)
    assert.equal(allServers(context).length, 2)
    const mounted = mountableServers(context)
    assert.equal(mounted.find(item => item.id === 'shared').url, 'https://project/mcp')
    assert.equal(mounted.find(item => item.id === 'shared').scope, 'project')
  } finally {
    box.cleanup()
  }
})

test('a disabled entry is stored but never mounted', () => {
  const box = sandbox()
  try {
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('off', { enabled: false })] })
    assert.equal(mountableServers(readContext(box.profile)).length, 0)
    assert.equal(allServers(readContext(box.profile)).length, 1)
  } finally {
    box.cleanup()
  }
})

test('copy moves the definition without touching the source, move removes it', () => {
  const box = sandbox()
  try {
    commit(readContext(box.profile), 'global', { revision: 0, servers: [entry('a')] })
    const context = readContext(box.profile, box.project)

    const copied = transferBetween(context, { from: 'global', to: 'project', ids: ['a'], mode: 'copy' })
    assert.equal(copied.ok, true)
    assert.equal(copied.source, undefined)
    commit(context, 'project', copied.target)

    const collision = transferBetween(readContext(box.profile, box.project), {
      from: 'global', to: 'project', ids: ['a'], mode: 'copy',
    })
    assert.equal(collision.ok, false)
    assert.match(collision.message, /同名/u)

    // Move only becomes possible once the id is free on the receiving side.
    commit(readContext(box.profile, box.project), 'global', { revision: 0, servers: [] })
    const context2 = readContext(box.profile, box.project)
    const moved = transferBetween(context2, { from: 'project', to: 'global', ids: ['a'], mode: 'move' })
    assert.equal(moved.ok, true)
    assert.equal(moved.source.servers.length, 0)
    assert.equal(moved.target.servers.length, 1)
  } finally {
    box.cleanup()
  }
})

test('the project scope reports nothing when no project is open', () => {
  const box = sandbox()
  try {
    const context = readContext(box.profile)
    assert.equal(context.project, undefined)
    assert.equal(projectView(box.profile, box.project).present, false)
    const outcome = commit(context, 'project', { revision: 0, servers: [entry('a')] })
    assert.equal(outcome.ok, false)
    assert.match(outcome.message, /没有打开的项目/u)
  } finally {
    box.cleanup()
  }
})
