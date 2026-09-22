import assert from 'node:assert/strict'
import test from 'node:test'
import {
  DEFAULT_EXPLICIT_KEYWORDS,
  DEFAULT_EXTRACTION_RULES,
  collectTurnMessages,
  extractionPrompts,
  extractMemories,
  hasExplicitRequest,
  parseExtraction,
  renderTranscript,
} from '../lib/memory/extract.js'

const rules = (overrides) => ({ ...DEFAULT_EXTRACTION_RULES, ...overrides })

const events = [
  { seq: 0, type: 'session/created', data: {} },
  { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '我们统一用 pnpm' }] } },
  { seq: 2, type: 'tool/result', data: { content: [{ type: 'text', text: 'noise' }] } },
  { seq: 3, type: 'assistant/message', data: { content: [{ type: 'text', text: '好的，记下了。' }] } },
  { seq: 4, type: 'user/message', data: { content: [{ type: 'text', text: '  ' }] } },
]

test('collects only real conversation lines and reports the last sequence', () => {
  const collected = collectTurnMessages(events, 0)
  assert.deepEqual(collected.lines, [
    { role: 'user', text: '我们统一用 pnpm' },
    { role: 'assistant', text: '好的，记下了。' },
  ])
  assert.equal(collected.lastSeq, 4)
  assert.deepEqual(collectTurnMessages(events, 3).lines, [])
})

test('renders the newest transcript lines within the budget', () => {
  const rendered = renderTranscript([
    { role: 'user', text: '很早以前的问题' },
    { role: 'assistant', text: '最近一次回答' },
  ], 12)
  assert.equal(rendered, '助手：最近一次回答')
  assert.match(extractionPrompts({ transcript: [{ role: 'user', text: 'hi' }], existing: ['已有'] }).user, /已有/)
})

test('parses a fenced JSON answer and drops unusable items', () => {
  const drafts = parseExtraction([
    '这是提炼结果：',
    '```json',
    JSON.stringify([
      { kind: 'preference', content: '用户偏好中文回答', tags: ['沟通'], confidence: 0.9 },
      { kind: 'unknown-kind', content: '统一用 pnpm 构建', tags: 'not-an-array', confidence: 3 },
      { kind: 'fact', content: 'ok' },
      { kind: 'preference', content: '用户偏好中文回答' },
    ]),
    '```',
  ].join('\n'))
  assert.equal(drafts.length, 2)
  assert.equal(drafts[0].kind, 'preference')
  assert.deepEqual(drafts[0].tags, ['沟通'])
  assert.equal(drafts[1].kind, 'fact')
  assert.equal(drafts[1].confidence, 1)
})

test('returns nothing for prose or malformed answers', () => {
  assert.deepEqual(parseExtraction('没有值得记录的。'), [])
  assert.deepEqual(parseExtraction('[{ "content": '), [])
})

test('applies the kind allowlist, the confidence floor, and the per-turn cap', () => {
  const raw = JSON.stringify([
    { kind: 'preference', content: '用户喜欢喝霸王茶姬', confidence: 0.9 },
    { kind: 'fact', content: '项目部署在腾讯云', confidence: 0.9 },
    { kind: 'preference', content: '用户可能喜欢喝茶', confidence: 0.3 },
    { kind: 'decision', content: '决定统一使用 pnpm', confidence: 0.85 },
  ])
  assert.deepEqual(parseExtraction(raw, rules()).map((draft) => draft.kind), ['preference', 'fact', 'decision'])
  assert.deepEqual(parseExtraction(raw, rules({ kinds: ['preference'] })).map((draft) => draft.content), ['用户喜欢喝霸王茶姬'])
  assert.deepEqual(parseExtraction(raw, rules({ minConfidence: 0.95 })), [])
  assert.equal(parseExtraction(raw, rules({ maxFacts: 2 })).length, 2)
})

test('reads assistant text only when the rules allow it', () => {
  const turn = [
    { seq: 1, type: 'user/message', data: { content: [{ type: 'text', text: '我喜欢喝霸王茶姬' }] } },
    { seq: 2, type: 'assistant/message', data: { content: [{ type: 'text', text: '好的，记下了' }] } },
  ]
  assert.deepEqual(collectTurnMessages(turn, 0, { source: 'user' }).lines.map((line) => line.role), ['user'])
  assert.equal(collectTurnMessages(turn, 0, { source: 'both' }).lines.length, 2)
  assert.equal(collectTurnMessages(turn, 0).lines.length, 2)
})

test('detects an explicit request to remember something', () => {
  assert.equal(hasExplicitRequest(['你好，在吗'], DEFAULT_EXPLICIT_KEYWORDS), false)
  assert.equal(hasExplicitRequest(['记住我喜欢喝霸王茶姬'], DEFAULT_EXPLICIT_KEYWORDS), true)
  assert.equal(hasExplicitRequest(['Please remember that I use pnpm'], DEFAULT_EXPLICIT_KEYWORDS), true)
  assert.equal(hasExplicitRequest(['记住这个'], []), false)
})

test('passes custom focus and exclusion requirements to the model', () => {
  const prompts = extractionPrompts({
    transcript: [{ role: 'user', text: 'hi' }],
    existing: [],
    rules: rules({ focus: '只记医疗相关', exclude: '不要记时间', kinds: ['fact'] }),
  })
  assert.match(prompts.system, /只记医疗相关/)
  assert.match(prompts.system, /不要记时间/)
  assert.match(prompts.system, /只使用这些类型：fact/)
})

test('extracts through the injected model call', async () => {
  const drafts = await extractMemories(
    { transcript: [{ role: 'user', text: '我们统一用 pnpm' }], existing: [] },
    async () => '[{"kind":"convention","content":"项目统一使用 pnpm"}]',
    new AbortController().signal,
  )
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].content, '项目统一使用 pnpm')
})

test('surfaces model failures to the caller, which logs and moves on', async () => {
  await assert.rejects(
    () => extractMemories(
      { transcript: [{ role: 'user', text: 'hi' }], existing: [] },
      async () => { throw new Error('模型不可用') },
      new AbortController().signal,
    ),
    /模型不可用/,
  )
})

test('reports nothing once the pass was cancelled', async () => {
  const controller = new AbortController()
  controller.abort()
  const drafts = await extractMemories(
    { transcript: [{ role: 'user', text: 'hi' }], existing: [] },
    async () => { throw new Error('aborted') },
    controller.signal,
  )
  assert.deepEqual(drafts, [])
})
