import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RECALL_BUDGET,
  RecallCache,
  STANDING_BUDGET,
  STANDING_LIMIT,
  renderRecallBlock,
  renderStandingBlock,
  standingHits,
} from '../lib/memory/recall.js'

function hit(kind, content, updatedAt = Date.now()) {
  return { id: content, kind, content, tags: [], confidence: 1, createdAt: updatedAt, updatedAt, score: 0, sources: [] }
}

test('keeps preferences and conventions as the always-on set', () => {
  const hits = [
    hit('preference', '用户喜欢喝霸王茶姬'),
    hit('fact', '项目部署在腾讯云'),
    hit('convention', '项目统一使用 pnpm'),
  ]
  assert.deepEqual(standingHits(hits).map((item) => item.content), ['用户喜欢喝霸王茶姬', '项目统一使用 pnpm'])
  const many = Array.from({ length: STANDING_LIMIT + 5 }, (_, index) => hit('preference', `偏好 ${String(index)}`))
  assert.equal(standingHits(many).length, STANDING_LIMIT)
})

test('renders both blocks with their own budgets', () => {
  const standing = renderStandingBlock([hit('preference', '用户喜欢喝霸王茶姬')])
  assert.match(standing, /用户长期偏好/)
  assert.match(standing, /霸王茶姬/)
  const long = renderStandingBlock([hit('preference', 'x'.repeat(STANDING_BUDGET))])
  assert.equal(long.includes('x'.repeat(STANDING_BUDGET)), false)

  const related = renderRecallBlock([hit('fact', '部署在腾讯云')])
  assert.match(related, /相关记忆/)
  const capped = renderRecallBlock(Array.from({ length: 60 }, (_, index) => hit('fact', `事实${String(index)}`.repeat(6))))
  assert.ok(capped.length <= RECALL_BUDGET + 120)
  assert.equal(renderStandingBlock([]), '')
  assert.equal(renderRecallBlock([]), '')
})

test('serves the standing block on a brand new conversation', () => {
  const cache = new RecallCache()
  cache.setStanding([hit('preference', '用户喜欢喝霸王茶姬')])
  // No session block yet: the first turn of a new session still gets it.
  assert.match(cache.get('fresh-session'), /霸王茶姬/)
  assert.match(cache.get(undefined), /霸王茶姬/)
})

test('joins the standing block with the session block and forgets both on clear', () => {
  const cache = new RecallCache()
  cache.setStanding([hit('preference', '用户喜欢喝霸王茶姬')])
  cache.set('s1', [hit('fact', '这个项目用 pnpm')])
  const text = cache.get('s1')
  assert.ok(text.indexOf('用户长期偏好') < text.indexOf('相关记忆'))
  assert.equal(cache.get('s1').includes('pnpm'), true)

  cache.clear()
  assert.equal(cache.get('s1'), '')
})

test('reports what would be injected', () => {
  const cache = new RecallCache()
  assert.deepEqual(cache.stats(), { standingChars: 0, sessions: 0 })
  cache.setStanding([hit('preference', '用户喜欢喝霸王茶姬')])
  cache.set('s1', [hit('fact', '项目用 pnpm')])
  const stats = cache.stats()
  assert.ok(stats.standingChars > 0)
  assert.equal(stats.sessions, 1)
})

test('never leaks another conversation into a named session', () => {
  const cache = new RecallCache()
  cache.setStanding([hit('preference', '用户喜欢喝霸王茶姬')])
  cache.set('older', [hit('fact', '旧会话')])
  cache.set('newer', [hit('fact', '新会话')])
  // A named session without its own block sees the standing layer only.
  const fresh = cache.get('brand-new')
  assert.match(fresh, /霸王茶姬/)
  assert.equal(fresh.includes('新会话'), false)
  assert.match(cache.get('older'), /旧会话/)
  // Without a session identity the newest block is the best available guess.
  assert.match(cache.get(undefined), /新会话/)
  assert.match(cache.get(undefined), /霸王茶姬/)
})
