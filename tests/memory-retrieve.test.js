import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalContent,
  contentHash,
  cosine,
  decodeVector,
  encodeVector,
  ftsExpression,
  fuse,
  likeTerm,
  normalizeContent,
} from '../lib/memory/retrieve.js'

test('hashes one fact to one identity regardless of punctuation and spacing', () => {
  const hash = contentHash('用户喜欢喝霸王茶姬')
  assert.equal(contentHash('用户喜欢喝霸王茶姬。'), hash)
  assert.equal(contentHash('用户喜欢喝霸王茶姬！'), hash)
  assert.equal(contentHash('  用户喜欢喝  霸王茶姬 '), hash)
  assert.equal(contentHash('用户喜欢喝霸王茶姬,'), hash)
  assert.equal(canonicalContent(' 用户 喜欢喝“霸王茶姬”。 '), '用户喜欢喝霸王茶姬')
  assert.notEqual(contentHash('用户喜欢喝咖啡'), hash)
  assert.equal(normalizeContent('  a\n b  '), 'a b')
})

test('builds FTS expressions and a LIKE fallback for mixed scripts', () => {
  assert.equal(ftsExpression('pnpm build'), '"pnpm" OR "build"')
  assert.equal(ftsExpression('项目  使用 pnpm'), '"项目" OR "使用" OR "pnpm"')
  assert.equal(ftsExpression('   '), undefined)
  assert.equal(likeTerm('使用 pnpm 构建'), 'pnpm')
  assert.equal(likeTerm('记忆系统'), '记忆系统')
})

test('computes cosine similarity and treats zero vectors as unrelated', () => {
  assert.equal(cosine([1, 0], [1, 0]), 1)
  assert.equal(cosine([1, 0], [0, 1]), 0)
  assert.equal(cosine([0, 0], [1, 1]), 0)
  assert.ok(cosine([1, 1], [1, 0]) > 0.7)
})

test('round-trips vectors through their stored bytes', () => {
  const decoded = decodeVector(encodeVector([0.5, -1.25, 3]))
  assert.equal(decoded.length, 3)
  assert.equal(decoded[0], 0.5)
  assert.equal(decoded[1], -1.25)
  assert.equal(decodeVector(undefined).length, 0)
  assert.equal(decodeVector(new Uint8Array([1, 2, 3])).length, 0)
})

test('fuses two retrievers by reciprocal rank and reports the sources', () => {
  const fused = fuse([
    { name: 'fts', candidates: [{ id: 'a', score: 0 }, { id: 'b', score: 0 }] },
    { name: 'vector', candidates: [{ id: 'b', score: 0.9 }, { id: 'c', score: 0.8 }] },
  ], { topK: 3 })
  assert.deepEqual(fused.map((item) => item.id), ['b', 'a', 'c'])
  assert.deepEqual(fused[0].sources, ['fts', 'vector'])
  assert.deepEqual(fused[1].sources, ['fts'])
  assert.ok(fused[0].score > fused[1].score)
})

test('caps fusion output and prefers the earlier candidate on ties', () => {
  const fused = fuse([
    { name: 'fts', candidates: [{ id: 'a', score: 0 }, { id: 'b', score: 0 }] },
  ], { topK: 1 })
  assert.equal(fused.length, 1)
  assert.equal(fused[0].id, 'a')
  assert.deepEqual(fuse([], { topK: 5 }), [])
})
