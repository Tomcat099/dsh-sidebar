/**
 * Pre-flight handshake for MCP endpoints.
 *
 * A saved configuration is not a working connection. Before this plugin lets
 * one into the settings file — and again on every health check — it speaks the
 * MCP handshake itself: `initialize`, then `notifications/initialized`, then
 * `tools/list`. Only a server that answers all three is reported as usable.
 *
 * `stdio` entries are the exception: this process does not spawn them. The
 * official client does, under the Host's supervision, so a stdio entry is
 * reported as `managed` — meaning "handed over, outcome unobserved" — never as
 * healthy. That distinction is what keeps the UI from claiming a local process
 * works when nobody has seen it start.
 */

import {
  CLIENT_INFO,
  CLIENT_USER_AGENT,
  HANDSHAKE_TIMEOUT_MS,
  MAX_RESPONSE_BYTES,
  MCP_PROTOCOL_VERSION,
  TOOL_CACHE_LIMIT,
  VALIDATE_CONCURRENCY,
} from './constants.js'
import type { McpServerEntry } from './schema.js'

/** Why a handshake did not reach `tools/list`. */
export type ProbeFailureKind =
  /** The endpoint answered 401/403 or rejected the token. */
  | 'auth'
  /** A referenced environment variable is empty, so no credential was sent. */
  | 'authorization-required'
  /** The deadline passed before the server answered. */
  | 'timeout'
  /** The host name did not resolve. */
  | 'dns'
  /** The TLS handshake failed (expired, self-signed, wrong chain). */
  | 'tls'
  /** Nothing is listening on the address. */
  | 'refused'
  /** Connection reset, socket hang up, or another transport error. */
  | 'network'
  /** The server asked the client to slow down. */
  | 'rate-limit'
  /** The endpoint is reachable but does not speak MCP. */
  | 'protocol'
  /** A non-2xx status that is none of the above. */
  | 'http'
  /** The user asked for a local process but the executable is missing. */
  | 'process-not-found'
  /** A local process started and exited before completing the handshake. */
  | 'process-exit'
  /** A local process never completed the handshake for another reason. */
  | 'startup'
  /** The Host cannot report registration state for this entry. */
  | 'host-status-unavailable'
  /** The Host reported an error while reading registration state. */
  | 'host-status-error'
  /** The Host has not finished registering the tools yet. */
  | 'host-tools-pending'
  /** The connection works but listing tools failed. */
  | 'tool-list'

/** Outcome kind of one probe. */
export type ProbeKind = 'connected' | 'managed' | ProbeFailureKind

/** One tool as reported by `tools/list`. */
export interface DiscoveredTool {
  /** Tool name, without the `mcp__<server>__` prefix the Host adds. */
  name: string
  /** Human-readable title, when the server sends one. */
  title?: string
  /** Description the server publishes for the model. */
  description?: string
  /** Raw JSON Schema for the tool's arguments, trimmed by the catalog. */
  inputSchema?: unknown
}

/** What one probe learned. */
export interface ProbeResult {
  /** Server id this result describes. */
  id: string
  /** True only for {@link ProbeKind} `connected`. */
  ok: boolean
  /** Outcome class the diagnostics layer interprets. */
  kind: ProbeKind
  /** Client-visible explanation. */
  message: string
  /** Protocol revision the server acknowledged. */
  protocolVersion?: string
  /** Server identity as reported during `initialize`. */
  serverInfo?: { name?: string, version?: string }
  /** Tools returned by `tools/list`, when the probe got that far. */
  tools?: DiscoveredTool[]
  /** Server-requested delay before a retry, from `Retry-After`. */
  retryAfterMs?: number
  /** ISO timestamp of the attempt. */
  checkedAt: string
}

/** Options for one probe. */
export interface ProbeOptions {
  /** Override the handshake deadline. */
  timeoutMs?: number
  /** Skip `tools/list`; used when only reachability matters. */
  skipTools?: boolean
  /** Injectable fetch, so tests can drive the probe without a socket. */
  fetchImpl?: typeof fetch
}

/** One JSON-RPC response envelope, narrowed to what the probe reads. */
interface RpcEnvelope {
  jsonrpc?: unknown
  id?: unknown
  result?: unknown
  error?: { code?: unknown, message?: unknown, data?: unknown }
}

/** A JSON-RPC failure carrying a classification. */
class RpcError extends Error {
  /** Failure class the probe reports. */
  readonly kind: ProbeFailureKind

  /** Server-requested retry delay, when the failure carried one. */
  readonly retryAfterMs?: number

  /**
   * @param kind - failure class.
   * @param message - client-visible explanation.
   * @param retryAfterMs - delay the server asked for, when it sent one.
   */
  constructor(kind: ProbeFailureKind, message: string, retryAfterMs?: number) {
    super(message)
    this.kind = kind
    this.retryAfterMs = retryAfterMs
  }
}

/**
 * Flatten an error and its `cause` chain into searchable text.
 * @param error - thrown value.
 * @returns upper-cased fragments; at most eight links are followed.
 */
function errorChain(error: unknown): string[] {
  const parts: string[] = []
  let current: unknown = error
  for (let depth = 0; depth < 8 && current !== undefined && current !== null; depth += 1) {
    if (current instanceof Error) {
      if (current.name !== '') parts.push(current.name)
      if (current.message !== '') parts.push(current.message)
      current = (current as { cause?: unknown }).cause
      continue
    }
    parts.push(String(current))
    break
  }
  return parts
}

/**
 * Classify a transport-level throw into a probe failure kind.
 * @param error - value thrown by `fetch` or the reader.
 * @returns the class and a short user-facing explanation.
 */
function classifyTransportError(error: unknown): { kind: ProbeFailureKind, message: string } {
  const text = errorChain(error).join(' | ')
  if (/abort|timeout|timed out/iu.test(text)) {
    return { kind: 'timeout', message: '连接超时，服务器没有在限定时间内响应' }
  }
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/iu.test(text)) {
    return { kind: 'dns', message: '域名解析失败，请检查地址、DNS 或代理' }
  }
  if (/CERT_|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|DEPTH_ZERO|altname|certificate/iu.test(text)) {
    return { kind: 'tls', message: 'TLS 证书校验失败，请检查证书链、VPN 或来源 IP 白名单' }
  }
  if (/ECONNREFUSED/iu.test(text)) {
    return { kind: 'refused', message: '连接被拒绝，请确认 URL 与目标服务是否在运行' }
  }
  if (/ECONNRESET|EPIPE|socket hang up|other side closed/iu.test(text)) {
    return { kind: 'network', message: '连接被中断，请检查网络与目标服务状态' }
  }
  return { kind: 'network', message: `网络错误：${text.split(' | ')[0] ?? '未知原因'}` }
}

/**
 * Whether a JSON-RPC error message reads like an authentication refusal.
 * @param message - text from the error member.
 * @returns true when the text names a credential problem.
 */
function looksLikeAuth(message: string): boolean {
  return /unauthori[sz]ed|forbidden|invalid.?token|invalid.?key|credential|access.?denied|未授权|无权|密钥|令牌/iu.test(message)
}

/**
 * Read a response body while enforcing a hard byte ceiling.
 *
 * The declared `content-length` is checked first so an oversized body is never
 * downloaded; the streaming check then covers a lying header or a chunked
 * response with no end.
 * @param response - response to consume.
 * @param maxBytes - hard ceiling.
 * @returns the decoded UTF-8 body.
 */
async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RpcError('protocol', `响应过大（声明 ${String(declared)} 字节，上限 ${String(maxBytes)}）`)
  }
  if (response.body === null) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value === undefined) continue
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new RpcError('protocol', `响应超过 ${String(Math.round(maxBytes / 1024))} KiB 上限，已中断读取`)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * Extract the first JSON-RPC envelope from a response body.
 *
 * Streamable HTTP servers may answer with `text/event-stream` even for a single
 * reply, so the `data:` lines are parsed in order and the first usable envelope
 * wins. Invalid events are skipped rather than treated as a hard failure: some
 * servers interleave keep-alive comments.
 * @param body - raw response text.
 * @param contentType - response content type, used to pick the parse strategy.
 * @returns the envelope, or undefined when the body held none.
 */
function parseEnvelope(body: string, contentType: string): RpcEnvelope | undefined {
  const trimmed = body.trim()
  if (trimmed === '') return undefined
  if (contentType.includes('text/event-stream')) {
    for (const line of trimmed.split(/\r?\n/u)) {
      const match = /^data:\s*(.*)$/u.exec(line.trim())
      if (match === null) continue
      const payload = match[1].trim()
      if (payload === '' || payload === '[DONE]') continue
      try {
        const parsed: unknown = JSON.parse(payload)
        if (typeof parsed === 'object' && parsed !== null) return parsed as RpcEnvelope
      } catch {
        continue
      }
    }
    return undefined
  }
  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (Array.isArray(parsed)) {
      const first = parsed.find(item => typeof item === 'object' && item !== null)
      return first === undefined ? undefined : first as RpcEnvelope
    }
    return typeof parsed === 'object' && parsed !== null ? parsed as RpcEnvelope : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a `initialize` result looks like a real MCP handshake.
 * @param result - the `result` member.
 * @returns true when the protocol revision and server identity are present.
 */
function isInitializeResult(result: unknown): boolean {
  if (typeof result !== 'object' || result === null) return false
  const value = result as Record<string, unknown>
  return typeof value.protocolVersion === 'string'
    && (typeof value.serverInfo === 'object' || typeof value.capabilities === 'object')
}

/**
 * Narrow one `tools/list` entry.
 * @param value - candidate from the response.
 * @returns the tool, or undefined when it has no usable name.
 */
function toDiscoveredTool(value: unknown): DiscoveredTool | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const raw = value as Record<string, unknown>
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return undefined
  const tool: DiscoveredTool = { name: raw.name.trim() }
  if (typeof raw.title === 'string' && raw.title.trim() !== '') tool.title = raw.title.trim()
  if (typeof raw.description === 'string' && raw.description.trim() !== '') tool.description = raw.description.trim()
  if (typeof raw.inputSchema === 'object' && raw.inputSchema !== null) tool.inputSchema = raw.inputSchema
  return tool
}

/**
 * Build the header set for one entry, resolving secret references at call time.
 * @param entry - configured server.
 * @returns headers to send, plus the names of empty secret variables.
 */
function requestHeaders(entry: McpServerEntry): { headers: Record<string, string>, missing: string[] } {
  const headers: Record<string, string> = { ...(entry.headers ?? {}) }
  const missing: string[] = []
  for (const [name, variable] of Object.entries(entry.headerEnv ?? {})) {
    const secret = process.env[variable]
    if (secret === undefined || secret === '') {
      missing.push(variable)
      continue
    }
    headers[name] = `Bearer ${secret}`
  }
  return { headers, missing }
}

/**
 * Parse a `Retry-After` header into milliseconds.
 * @param value - raw header value, either seconds or an HTTP date.
 * @returns the delay in milliseconds, or undefined when unparseable.
 */
function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined
  const seconds = Number(value.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const at = Date.parse(value)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, at - Date.now())
}

/**
 * Map a non-2xx status onto a probe failure kind.
 * @param status - HTTP status code.
 * @returns the class and a user-facing explanation.
 */
function classifyStatus(status: number): { kind: ProbeFailureKind, message: string } {
  if (status === 401 || status === 403) {
    return { kind: 'auth', message: `服务器返回 ${String(status)}：鉴权失败，请更新 token 或重新填写凭据` }
  }
  if (status === 429) {
    return { kind: 'rate-limit', message: '服务器返回 429：请求过于频繁，稍后会自动重试' }
  }
  if (status >= 500) {
    return { kind: 'http', message: `服务器返回 ${String(status)}：服务暂时异常` }
  }
  return { kind: 'http', message: `服务器返回 ${String(status)}，不是预期的 MCP 响应` }
}

/**
 * Speak the MCP handshake against one HTTP endpoint.
 * @param entry - configured server; must use the `streamable-http` transport.
 * @param options - deadline, tool-listing opt-out, and fetch injection.
 * @returns the probe result; never throws.
 */
export async function probeHttp(entry: McpServerEntry, options: ProbeOptions = {}): Promise<ProbeResult> {
  const checkedAt = new Date().toISOString()
  const base = { id: entry.id, checkedAt }
  if (entry.url === undefined || entry.url.trim() === '') {
    return { ...base, ok: false, kind: 'protocol', message: '缺少 url' }
  }
  const { headers, missing } = requestHeaders(entry)
  if (missing.length > 0) {
    return {
      ...base,
      ok: false,
      kind: 'authorization-required',
      message:
        `环境变量 ${missing.join('、')} 在当前进程里是空的，没有发送凭据。` +
        `如果刚写进 ~/.dsh/.env，需要重启 dsh web 才会生效`,
    }
  }
  const doFetch = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? HANDSHAKE_TIMEOUT_MS
  const timer = setTimeout(() => { controller.abort(new Error('timeout')) }, timeoutMs)
  const common = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'user-agent': CLIENT_USER_AGENT,
    ...headers,
  }
  let sessionId: string | undefined
  try {
    const post = async (payload: unknown): Promise<{ status: number, body: string, contentType: string }> => {
      const response = await doFetch(entry.url as string, {
        method: 'POST',
        headers: sessionId === undefined ? common : { ...common, 'mcp-session-id': sessionId },
        body: JSON.stringify(payload),
        redirect: 'manual',
        signal: controller.signal,
      })
      const contentType = response.headers.get('content-type') ?? ''
      const assigned = response.headers.get('mcp-session-id')
      if (assigned !== null && assigned !== '') sessionId = assigned
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'))
        throw new RpcError('rate-limit', '服务器返回 429：请求过于频繁，稍后会自动重试', retryAfterMs)
      }
      const body = await readLimitedText(response, MAX_RESPONSE_BYTES)
      if (response.status >= 400) {
        const verdict = classifyStatus(response.status)
        throw new RpcError(verdict.kind, verdict.message)
      }
      return { status: response.status, body, contentType }
    }

    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { ...CLIENT_INFO },
      },
    })
    const initEnvelope = parseEnvelope(init.body, init.contentType)
    if (initEnvelope === undefined) {
      return { ...base, ok: false, kind: 'protocol', message: '服务器没有返回可解析的 MCP 响应，请确认 URL 指向 Streamable HTTP 端点' }
    }
    if (initEnvelope.error !== undefined) {
      const text = String(initEnvelope.error.message ?? '未知错误')
      return {
        ...base,
        ok: false,
        kind: looksLikeAuth(text) ? 'auth' : 'protocol',
        message: `MCP 初始化被拒绝：${text.slice(0, 180)}`,
      }
    }
    if (!isInitializeResult(initEnvelope.result)) {
      return { ...base, ok: false, kind: 'protocol', message: '响应不是合法的 MCP initialize 结果，请确认 URL 指向兼容的 Streamable HTTP 端点' }
    }
    const result = initEnvelope.result as Record<string, unknown>
    const serverInfo = typeof result.serverInfo === 'object' && result.serverInfo !== null
      ? result.serverInfo as { name?: unknown, version?: unknown }
      : undefined
    const protocolVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : undefined

    if (options.skipTools === true) {
      return {
        ...base,
        ok: true,
        kind: 'connected',
        message: '握手成功',
        protocolVersion,
        serverInfo: serverInfo === undefined ? undefined : {
          name: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
          version: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
        },
      }
    }

    await post({ jsonrpc: '2.0', method: 'notifications/initialized' }).catch(() => undefined)

    const tools: DiscoveredTool[] = []
    let cursor: string | undefined
    for (let page = 0; page < 10; page += 1) {
      const listing = await post({
        jsonrpc: '2.0',
        id: 2 + page,
        method: 'tools/list',
        params: cursor === undefined ? {} : { cursor },
      })
      const envelope = parseEnvelope(listing.body, listing.contentType)
      if (envelope === undefined) {
        return { ...base, ok: false, kind: 'tool-list', message: 'tools/list 没有返回可解析的响应' }
      }
      if (envelope.error !== undefined) {
        const text = String(envelope.error.message ?? '未知错误')
        return {
          ...base,
          ok: false,
          kind: looksLikeAuth(text) ? 'auth' : 'tool-list',
          message: `列出工具失败：${text.slice(0, 180)}`,
        }
      }
      const payload = envelope.result
      if (typeof payload !== 'object' || payload === null) {
        return { ...base, ok: false, kind: 'tool-list', message: 'tools/list 的结果不是对象' }
      }
      const raw = payload as { tools?: unknown, nextCursor?: unknown }
      if (Array.isArray(raw.tools)) {
        for (const item of raw.tools) {
          const tool = toDiscoveredTool(item)
          if (tool !== undefined && tools.length < TOOL_CACHE_LIMIT) tools.push(tool)
        }
      }
      cursor = typeof raw.nextCursor === 'string' && raw.nextCursor !== '' ? raw.nextCursor : undefined
      if (cursor === undefined || tools.length >= TOOL_CACHE_LIMIT) break
    }

    return {
      ...base,
      ok: true,
      kind: 'connected',
      message: `握手成功，发现 ${String(tools.length)} 个工具`,
      protocolVersion,
      serverInfo: serverInfo === undefined ? undefined : {
        name: typeof serverInfo.name === 'string' ? serverInfo.name : undefined,
        version: typeof serverInfo.version === 'string' ? serverInfo.version : undefined,
      },
      tools,
    }
  } catch (error) {
    if (error instanceof RpcError) {
      const result: ProbeResult = { ...base, ok: false, kind: error.kind, message: error.message }
      if (error.retryAfterMs !== undefined) result.retryAfterMs = error.retryAfterMs
      return result
    }
    const verdict = classifyTransportError(error)
    return { ...base, ok: false, kind: verdict.kind, message: verdict.message }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe one entry, choosing the strategy its transport implies.
 *
 * stdio entries are handed to the Host's client and never observed here, so
 * they come back as `managed` rather than `connected`.
 * @param entry - configured server.
 * @param options - probe options.
 * @returns the probe result; never throws.
 */
export async function probeEntry(entry: McpServerEntry, options: ProbeOptions = {}): Promise<ProbeResult> {
  if (entry.transport === 'stdio') {
    return {
      id: entry.id,
      ok: false,
      kind: 'managed',
      message: '本地进程由 DSH 启动，此处不主动探测',
      checkedAt: new Date().toISOString(),
    }
  }
  return probeHttp(entry, options)
}

/**
 * Probe several entries with a bounded number of in-flight requests.
 *
 * Concurrency is capped so a long list cannot open dozens of sockets at once,
 * and so a provider that rate-limits per client is not tripped by the UI.
 * @param entries - servers to probe.
 * @param options - probe options; `concurrency` bounds in-flight requests.
 * @returns results keyed by server id, in input order.
 */
export async function probeEntries(
  entries: readonly McpServerEntry[],
  options: ProbeOptions & { concurrency?: number } = {},
): Promise<Map<string, ProbeResult>> {
  const results = new Map<string, ProbeResult>()
  if (entries.length === 0) return results
  const limit = Math.max(1, Math.min(options.concurrency ?? VALIDATE_CONCURRENCY, entries.length))
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const entry = entries[index]
      if (entry === undefined) return
      results.set(entry.id, await probeEntry(entry, options))
    }
  }
  await Promise.all(Array.from({ length: limit }, worker))
  return results
}
