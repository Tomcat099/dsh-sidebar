import assert from 'node:assert/strict'
import test from 'node:test'
import { createEmbedder, readEmbeddingsBody } from '../lib/memory/embedding.js'

function stubFetch(vectorLength, capture) {
  const original = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    capture.url = String(url)
    capture.body = JSON.parse(String(init.body))
    capture.headers = init.headers
    return new Response(JSON.stringify({
      data: [Array.from({ length: vectorLength }, (_, index) => (index === 0 ? 1 : 0))],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return () => { globalThis.fetch = original }
}

test('stays disabled until an endpoint and model are configured', () => {
  assert.equal(createEmbedder({ enabled: false, baseURL: 'https://x/v1', apiKey: '', model: 'm', dim: 0 }), undefined)
  assert.equal(createEmbedder({ enabled: true, baseURL: '', apiKey: '', model: 'm', dim: 0 }), undefined)
  assert.equal(createEmbedder({ enabled: true, baseURL: 'https://x/v1', apiKey: '', model: '', dim: 0 }), undefined)
})

test('asks for the configured dimension and adopts what the endpoint returns', async () => {
  const capture = {}
  const restore = stubFetch(1024, capture)
  const observed = []
  try {
    const embedder = createEmbedder(
      { enabled: true, baseURL: 'https://api.example.com/v1/', apiKey: 'sk-test', model: 'text-embedding-v4', dim: 1536 },
      { onDim: (actual, configured) => observed.push([actual, configured]) },
    )
    assert.ok(embedder)
    const vectors = await embedder.embed(['喜欢喝霸王茶姬'])
    assert.equal(capture.url, 'https://api.example.com/v1/embeddings')
    assert.equal(capture.body.dimensions, 1536)
    assert.equal(capture.headers.authorization, 'Bearer sk-test')
    // The answer wins instead of failing the caller, and the mismatch is reported.
    assert.equal(vectors[0].length, 1024)
    assert.deepEqual(observed, [[1024, 1536]])
    assert.equal(embedder.dim, 1024)
  } finally {
    restore()
  }
})

test('leaves dimensions unset when the configuration asks for any length', async () => {
  const capture = {}
  const restore = stubFetch(768, capture)
  const observed = []
  try {
    const embedder = createEmbedder(
      { enabled: true, baseURL: 'https://api.example.com/v1', apiKey: '', model: 'm', dim: 0 },
      { onDim: (actual, configured) => observed.push([actual, configured]) },
    )
    await embedder.embed(['x'])
    assert.equal('dimensions' in capture.body, false)
    assert.equal('authorization' in capture.headers, false)
    assert.deepEqual(observed, [[768, 0]])
  } finally {
    restore()
  }
})

test('reports a mismatch only once per observed length', async () => {
  const capture = {}
  const restore = stubFetch(1024, capture)
  const observed = []
  try {
    const embedder = createEmbedder(
      { enabled: true, baseURL: 'https://api.example.com/v1', apiKey: '', model: 'm', dim: 1536 },
      { onDim: (actual, configured) => observed.push([actual, configured]) },
    )
    await embedder.embed(['one'])
    await embedder.embed(['two'])
    assert.equal(observed.length, 1)
  } finally {
    restore()
  }
})

test('reads vectors from either response shape and rejects junk', () => {
  assert.equal(readEmbeddingsBody({ data: [{ embedding: [1, 2] }] })[0].length, 2)
  assert.equal(readEmbeddingsBody({ embeddings: [[1, 2, 3]] })[0].length, 3)
  assert.deepEqual(readEmbeddingsBody({ data: [{ embedding: ['x'] }] }), [])
  assert.deepEqual(readEmbeddingsBody({}), [])
})
