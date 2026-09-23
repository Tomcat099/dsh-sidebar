import assert from 'node:assert/strict'
import test from 'node:test'
import { renderEntry, renderStandaloneEntry } from '../lib/mcp/store.js'

/**
 * Indentation sanity for one rendered row.
 *
 * The regression this guards against: only the `- id:` line followed the
 * `indent` argument while the rest kept absolute depths from the retired
 * patch-layer projection, producing YAML no parser accepts. Rather than pull
 * in a parser, the invariant is stated directly — every key of the row's
 * mapping starts at `indent + 2`, and nothing between the marker and the next
 * row starts at a shallower column.
 * @param {string} block - rendered row.
 * @param {number} indent - expected row indent.
 */
function checkIndent(block, indent) {
  const lines = block.split('\n')
  assert.ok(lines[0].startsWith(`${' '.repeat(indent)}- id: `), `首行应是 ${indent} 空格 + "- id: "：${lines[0]}`)
  for (const line of lines.slice(1)) {
    assert.match(line, new RegExp(`^ {${indent + 2},}\\S`), `续行应至少缩进到 ${indent + 2} 列：${line}`)
  }
}

test('an HTTP entry renders as a valid standalone include row', () => {
  const text = renderStandaloneEntry({
    id: 'mysql',
    enabled: true,
    transport: 'streamable-http',
    url: 'http://127.0.0.1:8091/mysql',
    headers: { Authorization: 'Bearer abc' },
  })
  assert.equal(text, [
    '- id: mcp-mysql',
    "  name: '@deepseek-ai/dsh-mcp-client'",
    '  config:',
    '    serverName: mysql',
    '    transport: streamable-http',
    "    url: 'http://127.0.0.1:8091/mysql'",
    '    headers:',
    "      Authorization: 'Bearer abc'",
  ].join('\n'))
  checkIndent(text, 0)
})

test('a stdio entry keeps its nested env block aligned', () => {
  const text = renderStandaloneEntry({
    id: 'fs',
    enabled: true,
    transport: 'stdio',
    command: 'npx',
    args: ['-y', 'some-server'],
    env: { LITERAL: 'one' },
    envEnv: { TOKEN: 'MY_TOKEN' },
  })
  checkIndent(text, 0)
  assert.match(text, /^    command: 'npx'$/m)
  assert.match(text, /^    args: \['-y', 'some-server'\]$/m)
  assert.match(text, /^    env:$/m)
  assert.match(text, /^      LITERAL: 'one'$/m)
  assert.match(text, /^      TOKEN: !!js process\.env\.MY_TOKEN$/m)
})

test('every continuation line follows the indent argument', () => {
  // Managed-block depth: the row marker sits at 4, so its keys must sit at 6,
  // not at the old hardcoded 6-and-8 mix that broke parsing at depth 0.
  const shallow = renderEntry({ id: 'a', enabled: true, transport: 'streamable-http', url: 'https://a/mcp' }, 0)
  const nested = renderEntry({ id: 'a', enabled: true, transport: 'streamable-http', url: 'https://a/mcp' }, 4)
  for (const [block, indent] of [[shallow, 0], [nested, 4]]) {
    checkIndent(block, indent)
  }
  // The same entry at different indents differs only by the shared prefix.
  assert.equal(nested, shallow.split('\n').map(line => `    ${line}`).join('\n'))
})
