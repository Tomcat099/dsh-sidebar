/**
 * Minimal reader/writer for the Harness-home `.env`.
 *
 * DSH layers this file under the inherited process environment and materializes
 * its values into `process.env` before any config entry mounts, which is what
 * makes a `!!js process.env.VAR` reference in a generated mount list resolve at
 * boot. Two consequences shape this module:
 *
 * 1. It cannot be a general-purpose env editor. Comments, ordering, and every
 *    unrelated line survive byte-for-byte; only the keys being written change.
 * 2. Some names are refused outright. `dsh-app-boot` throws on a `.env` that
 *    declares a bootstrap-deciding name, and that throw happens during boot —
 *    so writing one would leave the user with a harness that will not start.
 *    {@link isReservedEnvName} mirrors that list rather than trusting callers.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * Exact names no discovered `.env` may set, mirroring `dsh-app-boot`.
 *
 * Kept as a literal copy rather than imported: this plugin must stay
 * installable beside any DSH version, including ones that do not export the
 * list.
 */
const RESERVED_NAMES = new Set([
  'PATH', 'HOME', 'USERPROFILE', 'SHELL', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS',
  'PERL5OPT', 'PERL5LIB', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB',
  'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'PYTHONHOME',
  'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_ASKPASS',
  'SSH_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT',
  'EDITOR', 'VISUAL', 'PAGER', 'BROWSER',
  'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL',
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_TLS_REJECT_UNAUTHORIZED',
])

/** Prefixes no discovered `.env` may set, mirroring `dsh-app-boot`. */
const RESERVED_PREFIXES = ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_']

/** Valid JavaScript environment variable name. */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u

/** Printable ASCII with no whitespace. */
const PRINTABLE_ASCII = /^[\x21-\x7E]+$/u

/**
 * Characters that can change how a line is parsed.
 *
 * The DSH `.env` parser is not re-implemented here, so a value needing quotes,
 * escaping, or interpolation is refused rather than guessed at — every
 * credential this plugin migrates is a token made of letters, digits, and
 * `-_.~+/=:`, so the narrow rule costs nothing.
 */
const RISKY_CHARACTERS = /["'`#\\$]/u

/** Bumped when the file is rewritten, so it stays readable only by its owner. */
const FILE_MODE = 0o600

/**
 * Whether writing this name into a `.env` would stop the harness from booting.
 * @param name - variable name to test.
 * @returns true when the name is reserved for the launching environment.
 */
export function isReservedEnvName(name: string): boolean {
  const upper = name.toUpperCase()
  return RESERVED_NAMES.has(upper) || RESERVED_PREFIXES.some(prefix => upper.startsWith(prefix))
}

/**
 * Whether a value can be written without quoting.
 * @param value - value to test.
 * @returns true when the value is plain printable ASCII with no whitespace.
 */
export function isWritableValue(value: string): boolean {
  return PRINTABLE_ASCII.test(value) && !RISKY_CHARACTERS.test(value)
}

/**
 * Absolute path of the Harness-home `.env`.
 * @param dshHome - absolute DSH home directory.
 * @returns the file path.
 */
export function envFilePath(dshHome: string): string {
  return join(dshHome, '.env')
}

/** One key to write, plus the value it should hold. */
export interface EnvWrite {
  /** Variable name. */
  name: string
  /** Value to store. */
  value: string
}

/** Outcome of one upsert. */
export interface EnvWriteOutcome {
  /** Variable names that were added. */
  added: string[]
  /** Variable names whose existing value was replaced. */
  replaced: string[]
  /** Names that were refused, with the reason. */
  refused: Array<{ name: string, reason: string }>
}

/**
 * Compose the `NAME=value` line for one entry.
 * @param write - entry to serialize.
 * @returns the line, without a trailing newline.
 */
function renderLine(write: EnvWrite): string {
  return `${write.name}=${write.value}`
}

/**
 * Read the file into its lines, or an empty list when it does not exist.
 * @param file - absolute path.
 * @returns the lines, without trailing newlines.
 */
function readLines(file: string): string[] {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split(/\r?\n/u)
}

/**
 * Detect the variable name a line assigns, ignoring comments and blanks.
 * @param line - one line from the file.
 * @returns the assigned name, or undefined when the line assigns nothing.
 */
function assignedName(line: string): string | undefined {
  const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line)
  return match === null ? undefined : match[1]
}

/**
 * Add or replace entries in the Harness-home `.env`.
 *
 * Existing lines are rewritten in place so the file keeps its ordering and
 * comments; new keys are appended under a short marker. Writes go through a
 * temporary file plus a rename, and the file is forced to `0600` afterwards,
 * because it holds credentials.
 * @param file - absolute path of the `.env`.
 * @param writes - entries to add or replace.
 * @returns which names were added, replaced, or refused.
 */
export function upsertEnvFile(file: string, writes: readonly EnvWrite[]): EnvWriteOutcome {
  const outcome: EnvWriteOutcome = { added: [], replaced: [], refused: [] }
  const accepted: EnvWrite[] = []
  for (const write of writes) {
    if (!ENV_VAR_NAME.test(write.name)) {
      outcome.refused.push({ name: write.name, reason: '不是合法的环境变量名' })
      continue
    }
    if (isReservedEnvName(write.name)) {
      outcome.refused.push({ name: write.name, reason: '这个变量名由启动环境占用，写进 .env 会导致 DSH 无法启动' })
      continue
    }
    if (!isWritableValue(write.value)) {
      outcome.refused.push({ name: write.name, reason: '值里含空格或非 ASCII 字符，请手动写入 .env' })
      continue
    }
    accepted.push(write)
  }
  if (accepted.length === 0) return outcome

  const pending = new Map(accepted.map(write => [write.name, write]))
  const lines = readLines(file)
  const kept: string[] = []
  for (const line of lines) {
    const name = assignedName(line)
    const write = name === undefined ? undefined : pending.get(name)
    if (write === undefined) {
      kept.push(line)
      continue
    }
    kept.push(renderLine(write))
    outcome.replaced.push(write.name)
    pending.delete(write.name)
  }
  while (kept.length > 0 && kept[kept.length - 1].trim() === '') kept.pop()
  if (pending.size > 0) {
    kept.push('', '# 由 dsh-sidebar 写入：MCP 服务器的凭据。改这里之后需要重启 dsh web。')
    for (const write of pending.values()) {
      kept.push(renderLine(write))
      outcome.added.push(write.name)
    }
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const text = `${kept.join('\n')}\n`
  const temporary = `${file}.${String(process.pid)}.tmp`
  writeFileSync(temporary, text, { encoding: 'utf8', mode: FILE_MODE })
  renameSync(temporary, file)
  try {
    chmodSync(file, FILE_MODE)
  } catch {
    // A filesystem without POSIX modes is not a reason to fail the write.
  }
  return outcome
}
