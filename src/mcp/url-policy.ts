/**
 * Outbound URL policy for MCP endpoints entered by hand.
 *
 * A configured endpoint is fetched by this process, so the rules here decide
 * how much of the local network a mistyped or hostile URL can reach. The shape
 * is deliberately narrow: HTTPS anywhere, plain HTTP only to the loopback
 * interface, and private ranges only after the user confirms the risk.
 */

/** Why a URL was refused. */
export type UrlRejection =
  | 'malformed'
  | 'scheme'
  | 'credentials'
  | 'metadata'
  | 'link-local'
  | 'private-network'
  | 'insecure-remote'

/** Outcome of {@link checkUrl}. */
export interface UrlVerdict {
  /** True when the URL may be fetched. */
  ok: boolean
  /** Rejection class; absent when `ok` is true. */
  code?: UrlRejection
  /** Client-visible explanation; absent when `ok` is true. */
  message?: string
}

/** Options that relax the default policy. */
export interface UrlPolicyOptions {
  /**
   * Set when the user explicitly accepted plain HTTP to a private address.
   * Only RFC1918 IPv4 and RFC4193 IPv6 ULA literals honour it.
   */
  allowInsecurePrivateNetwork?: boolean
}

/** Hosts that only ever answer with cloud instance credentials. */
const METADATA_HOSTS = new Set([
  '169.254.169.254',
  '169.254.170.2',
  '100.100.100.200',
  'fd00:ec2::254',
  'metadata.google.internal',
])

/** Host names that always mean the local machine. */
const LOOPBACK_HOSTS = new Set(['localhost', 'localhost.localdomain', 'ip6-localhost'])

/**
 * Parse a dotted-quad IPv4 literal.
 * @param text - candidate hostname.
 * @returns the four octets, or undefined when the text is not an IPv4 literal.
 */
function ipv4Octets(text: string): number[] | undefined {
  const parts = text.split('.')
  if (parts.length !== 4) return undefined
  const octets: number[] = []
  for (const part of parts) {
    if (!/^\d{1,3}$/u.test(part)) return undefined
    const value = Number(part)
    if (value > 255) return undefined
    octets.push(value)
  }
  return octets
}

/**
 * Pull the trailing IPv4 address out of an IPv4-mapped IPv6 literal.
 * @param text - bracketed or bare IPv6 text.
 * @returns the four octets, or undefined when the address is not mapped.
 */
function mappedIpv4(text: string): number[] | undefined {
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/u.exec(text)
  if (dotted !== null) return ipv4Octets(dotted[1])
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/u.exec(text)
  if (hex === null) return undefined
  const high = Number.parseInt(hex[1], 16)
  const low = Number.parseInt(hex[2], 16)
  return [high >> 8, high & 0xff, low >> 8, low & 0xff]
}

/**
 * Classify an IPv4 address by reachability.
 * @param octets - four octets.
 * @returns the bucket the address belongs to.
 */
function classifyIpv4(octets: number[]): 'loopback' | 'link-local' | 'private' | 'public' {
  const [a, b] = octets
  if (a === 127) return 'loopback'
  if (a === 169 && b === 254) return 'link-local'
  if (a === 10) return 'private'
  if (a === 172 && b >= 16 && b <= 31) return 'private'
  if (a === 192 && b === 168) return 'private'
  return 'public'
}

/**
 * Classify an IPv6 address by reachability.
 * @param text - lowercased address without brackets.
 * @returns the bucket the address belongs to, or undefined when unparseable.
 */
function classifyIpv6(text: string): 'loopback' | 'link-local' | 'private' | 'public' | undefined {
  const mapped = mappedIpv4(text)
  if (mapped !== undefined) return classifyIpv4(mapped)
  if (text === '::1' || text === '0:0:0:0:0:0:0:1') return 'loopback'
  if (text === '::') return 'link-local'
  const head = text.split(':')[0]
  if (head === '') return undefined
  const value = Number.parseInt(head, 16)
  if (Number.isNaN(value)) return undefined
  if ((value & 0xffc0) === 0xfe80 || (value & 0xffc0) === 0xfec0) return 'link-local'
  if ((value & 0xfe00) === 0xfc00) return 'private'
  return 'public'
}

/**
 * Decide whether one configured endpoint may be contacted.
 * @param raw - the URL as typed by the user.
 * @param options - relaxations the user explicitly accepted.
 * @returns the verdict; `ok` false carries a client-visible reason.
 */
export function checkUrl(raw: string, options: UrlPolicyOptions = {}): UrlVerdict {
  const text = raw.trim()
  if (text === '') {
    return { ok: false, code: 'malformed', message: '没有填写 URL' }
  }
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return { ok: false, code: 'malformed', message: `「${text}」不是合法的 URL` }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return {
      ok: false,
      code: 'scheme',
      message: `只支持 http:// 或 https://，不支持 ${parsed.protocol}//`,
    }
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return {
      ok: false,
      code: 'credentials',
      message: 'URL 里不能带用户名或密码，请改用 Authorization 配置凭据',
    }
  }
  const host = parsed.hostname.toLowerCase()
  if (METADATA_HOSTS.has(host)) {
    return { ok: false, code: 'metadata', message: `拒绝访问云元数据地址 ${host}` }
  }
  const bucket = host.startsWith('[') || host.includes(':')
    ? classifyIpv6(host.replace(/^\[/u, '').replace(/\]$/u, ''))
    : LOOPBACK_HOSTS.has(host)
      ? 'loopback'
      : ipv4Octets(host) !== undefined
        ? classifyIpv4(ipv4Octets(host) as number[])
        : undefined
  if (bucket === 'link-local') {
    return { ok: false, code: 'link-local', message: `拒绝访问链路本地地址 ${host}` }
  }
  if (parsed.protocol === 'https:') return { ok: true }
  // Plain HTTP: loopback is always allowed, private ranges need the risk note,
  // and a public host or a domain name never is.
  if (bucket === 'loopback') return { ok: true }
  if (bucket === 'private') {
    if (options.allowInsecurePrivateNetwork === true) return { ok: true }
    return {
      ok: false,
      code: 'private-network',
      message: `「${host}」是内网地址。用明文 HTTP 连内网需要勾选「允许明文访问内网」后重试`,
    }
  }
  if (bucket === undefined) {
    return {
      ok: false,
      code: 'insecure-remote',
      message: `域名「${host}」不能用明文 HTTP，请改用 https://`,
    }
  }
  return {
    ok: false,
    code: 'insecure-remote',
    message: `公网地址「${host}」不能用明文 HTTP，请改用 https://`,
  }
}

/**
 * Whether a refusal class is the one the "allow insecure private network" switch
 * can clear, so the UI can offer the switch only when it would help.
 * @param code - rejection class.
 * @returns true when the switch is the fix.
 */
export function isRiskConfirmable(code: UrlRejection | undefined): boolean {
  return code === 'private-network'
}
