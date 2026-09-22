import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalMemoryProvider } from '../lib/memory/local.js'

/** Deterministic stand-in for the embedding endpoint. */
const embedder = {
  dim: 3,
  model: 'test-embed',
  async embed(texts) {
    return texts.map((text) => new Float32Array(
      text.includes('pnpm') ? [1, 0, 0] : text.includes('记忆') ? [0.5, 0.5, 0] : [0, 0, 1],
    ))
  },
}

function open() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-memory-'))
  const provider = new LocalMemoryProvider({ dbPath: join(dir, 'memory.sqlite'), embedder })
  return { provider, dir }
}

test('stores, lists, updates, and removes memories', async () => {
  const { provider, dir } = open()
  try {
    const first = await provider.write({ kind: 'preference', content: '  用户偏好中文回答  ', tags: ['沟通'] })
    assert.equal(first.created, true)
    assert.equal(await provider.count(), 1)

    const listed = await provider.list({ limit: 10, offset: 0 })
    assert.equal(listed.length, 1)
    assert.equal(listed[0].content, '用户偏好中文回答')
    assert.deepEqual(listed[0].tags, ['沟通'])

    await provider.update(listed[0].id, { content: '用户偏好简洁的中文回答', kind: 'preference' })
    const updated = await provider.list({ limit: 10, offset: 0 })
    assert.equal(updated[0].content, '用户偏好简洁的中文回答')
    assert.equal(updated[0].id, listed[0].id)

    await provider.remove(listed[0].id)
    assert.equal(await provider.count(), 0)
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collapses the same fact onto one row', async () => {
  const { provider, dir } = open()
  try {
    await provider.write({ kind: 'fact', content: '项目统一使用 pnpm' })
    const again = await provider.write({ kind: 'fact', content: '  项目统一使用   pnpm ' })
    assert.equal(again.created, false)
    assert.equal(await provider.count(), 1)
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('treats punctuation-only differences as one memory', async () => {
  const { provider, dir } = open()
  try {
    const first = await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬。', tags: ['饮品'] })
    const second = await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬', tags: ['饮品偏好'] })
    assert.equal(second.created, false)
    assert.equal(second.id, first.id)
    assert.equal(await provider.count(), 1)
    const [row] = await provider.list({ limit: 5, offset: 0 })
    assert.deepEqual([...row.tags].sort(), ['饮品', '饮品偏好'])

    // Re-extracting the same fact must not accumulate the same tag repeatedly.
    await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬', tags: ['饮品偏好'] })
    await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬', tags: ['饮品偏好', '饮品'] })
    const [again] = await provider.list({ limit: 5, offset: 0 })
    assert.deepEqual([...again.tags].sort(), ['饮品', '饮品偏好'])
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('merges a re-worded fact whose vector is near identical', async () => {
  const { provider, dir } = open()
  try {
    await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬' })
    await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬（常点）' })
    assert.equal(await provider.count(), 1)
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('finds memories by keyword and by tag through the LIKE fallback', async () => {
  const { provider, dir } = open()
  try {
    await provider.write({ kind: 'convention', content: '项目统一使用 pnpm', tags: ['工具链'] })
    await provider.write({ kind: 'fact', content: '部署在腾讯云轻量服务器上', tags: ['部署'] })

    const keyword = await provider.search({ text: 'pnpm', topK: 5, fusion: 'fulltext' })
    assert.equal(keyword.length, 1)
    assert.match(keyword[0].content, /pnpm/)

    const tagged = await provider.search({ text: '部署', topK: 5, fusion: 'rrf' })
    assert.equal(tagged.length, 1)
    assert.match(tagged[0].content, /腾讯云/)
    assert.ok(tagged[0].sources.includes('like') || tagged[0].sources.includes('fts'))
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ranks by vector similarity when embeddings exist', async () => {
  const { provider, dir } = open()
  try {
    await provider.write({ kind: 'convention', content: '项目统一使用 pnpm' })
    await provider.write({ kind: 'fact', content: '记忆库放在 .dsh 目录' })

    const hits = await provider.search({ text: 'pnpm 构建', topK: 2, fusion: 'vector' })
    assert.equal(hits.length, 2)
    assert.match(hits[0].content, /pnpm/)
    assert.deepEqual(hits[0].sources, ['vector'])
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('merges legacy duplicates that predate write-time deduplication', async () => {
  const { provider, dir } = open()
  const file = join(dir, 'memory.sqlite')
  try {
    await provider.write({ kind: 'preference', content: '用户喜欢喝霸王茶姬', tags: ['饮品'] })
    // A row written by an older build: different phrasing, stale hash scheme.
    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file)
    raw.prepare(
      `INSERT INTO memories(id, kind, content, tags, confidence, content_hash, created_at, updated_at)
       VALUES('legacy-row', 'preference', '用户喜欢喝霸王茶姬。', '饮品偏好', 1, 'legacy-hash', ?, ?)`,
    ).run(Date.now() - 60_000, Date.now() - 60_000)
    raw.close()

    const result = await provider.dedupe()
    assert.equal(result.removed, 1)
    assert.equal(await provider.count(), 1)
    const [row] = await provider.list({ limit: 5, offset: 0 })
    assert.deepEqual([...row.tags].sort(), ['饮品', '饮品偏好'])
    assert.equal((await provider.dedupe()).removed, 0)
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('upgrades a revision-1 database by rehashing and collapsing duplicates', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-sidebar-memory-'))
  const file = join(dir, 'memory.sqlite')
  try {
    const first = new LocalMemoryProvider({ dbPath: file })
    await first.write({ kind: 'preference', content: '占位' })
    first.close()

    const { DatabaseSync } = await import('node:sqlite')
    const raw = new DatabaseSync(file)
    raw.prepare('DELETE FROM memories').run()
    raw.prepare('DELETE FROM memories_fts').run()
    const insert = raw.prepare(
      `INSERT INTO memories(id, kind, content, tags, confidence, content_hash, created_at, updated_at)
       VALUES(?, 'preference', ?, '', 1, ?, ?, ?)`,
    )
    const now = Date.now()
    insert.run('old-1', '用户喜欢喝霸王茶姬。', 'v1-hash-a', now - 1000, now - 1000)
    insert.run('old-2', '用户喜欢喝霸王茶姬', 'v1-hash-b', now, now)
    raw.prepare("UPDATE memory_meta SET value = '1' WHERE key = 'schema_version'").run()
    raw.close()

    const upgraded = new LocalMemoryProvider({ dbPath: file })
    assert.equal(await upgraded.count(), 1)
    const [row] = await upgraded.list({ limit: 5, offset: 0 })
    assert.equal(row.id, 'old-1')
    assert.equal((await upgraded.search({ text: '霸王茶姬', topK: 3, fusion: 'fulltext' })).length, 1)
    upgraded.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('rebuilds stored vectors in place', async () => {
  const { provider, dir } = open()
  try {
    await provider.write({ kind: 'fact', content: '项目统一使用 pnpm' })
    const result = await provider.reembedAll()
    assert.equal(result.updated, 1)
    assert.equal(result.failed, 0)
    const health = await provider.health()
    assert.equal(health.ok, true)
    assert.equal(health.kind, 'local')
  } finally {
    provider.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
