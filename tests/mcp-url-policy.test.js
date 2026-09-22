import assert from 'node:assert/strict'
import test from 'node:test'
import { checkUrl, isRiskConfirmable } from '../lib/mcp/url-policy.js'

test('allows https anywhere', () => {
  assert.equal(checkUrl('https://mcp.example.com/mcp').ok, true)
  assert.equal(checkUrl('https://10.0.0.5/mcp').ok, true)
})

test('allows plain http only to the loopback interface', () => {
  assert.equal(checkUrl('http://127.0.0.1:3000/mcp').ok, true)
  assert.equal(checkUrl('http://localhost:8080/mcp').ok, true)
  assert.equal(checkUrl('http://[::1]/mcp').ok, true)
})

test('refuses plain http to a domain or a public address', () => {
  const domain = checkUrl('http://mcp.example.com/mcp')
  assert.equal(domain.ok, false)
  assert.equal(domain.code, 'insecure-remote')
  const publicIp = checkUrl('http://8.8.8.8/mcp')
  assert.equal(publicIp.ok, false)
  assert.equal(publicIp.code, 'insecure-remote')
})

test('holds private ranges behind an explicit acknowledgement', () => {
  const refused = checkUrl('http://192.168.1.10:8080/mcp')
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'private-network')
  assert.equal(isRiskConfirmable(refused.code), true)
  assert.equal(checkUrl('http://192.168.1.10:8080/mcp', { allowInsecurePrivateNetwork: true }).ok, true)
  assert.equal(checkUrl('http://10.1.2.3/mcp', { allowInsecurePrivateNetwork: true }).ok, true)
  assert.equal(checkUrl('http://172.31.9.9/mcp', { allowInsecurePrivateNetwork: true }).ok, true)
  assert.equal(checkUrl('http://172.32.9.9/mcp', { allowInsecurePrivateNetwork: true }).ok, false)
  assert.equal(checkUrl('http://[fd00::1]/mcp', { allowInsecurePrivateNetwork: true }).ok, true)
})

test('never allows link-local or cloud metadata addresses', () => {
  for (const raw of ['http://169.254.1.1/mcp', 'http://169.254.169.254/latest', 'https://metadata.google.internal/x']) {
    const verdict = checkUrl(raw, { allowInsecurePrivateNetwork: true })
    assert.equal(verdict.ok, false, raw)
  }
})

test('rejects non-http schemes, userinfo, and malformed input', () => {
  assert.equal(checkUrl('file:///etc/passwd').code, 'scheme')
  assert.equal(checkUrl('ftp://host/x').code, 'scheme')
  assert.equal(checkUrl('https://user:secret@host/mcp').code, 'credentials')
  assert.equal(checkUrl('not a url').code, 'malformed')
  assert.equal(checkUrl('   ').code, 'malformed')
})
