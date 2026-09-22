/**
 * Disk-backed skill catalog for the sidebar 「技能」 tab.
 *
 * Scans the same six roots the host filesystem provider uses, and only writes
 * the two ranks this plugin is allowed to change: project `.dsh/skills` (100)
 * and global `<dshHome>/skills` (400).
 */

import { access, cp, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { gunzipSync, inflateRawSync } from 'node:zlib'

/** Kebab-case skill names, matching the host grammar. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Where a discovered skill lives, for the card label. */
export type SkillScope = 'project' | 'global' | 'custom' | 'bundled'

/** One winning skill returned to the sidebar. */
export interface SkillView {
  /** Frontmatter `name`. */
  name: string
  /** Frontmatter `description`, truncated to 500 characters. */
  description: string
  /** Rank of the layer that won this name. */
  rank: number
  /** Layer bucket used by the card label. */
  scope: SkillScope
  /** Absolute directory (or flat-file path) of the winning copy. */
  sourceDir: string
  /** False when either invocation switch is off. */
  enabled: boolean
  /** Absolute path of the next copy this winner hides, when one exists. */
  shadowedBy?: string
}

/** One root the scanner walks, direct children only. */
export interface SkillRoot {
  /** Absolute directory to read. */
  path: string
  /** Host precedence. Lower wins. */
  rank: number
  /** Card bucket. */
  scope: SkillScope
  /** Skip a direct `.system` child, matching the user-dsh root. */
  skipSystem?: boolean
}

/** A directory under `<projectRoot>/skills` that can be installed. */
export interface SkillCandidate {
  /** Frontmatter name. */
  name: string
  /** Absolute source directory. */
  sourceDir: string
  /** Frontmatter description, truncated. */
  description: string
}

const DESCRIPTION_LIMIT = 500
const INVOCATION_KEYS = new Set(['disable-model-invocation', 'user-invocable'])

/**
 * Walk up from `cwd` to the nearest ancestor that contains `.git`.
 * @param cwd - starting directory.
 * @returns that ancestor, or `cwd` when none exists.
 */
export async function findProjectRoot(cwd: string): Promise<string> {
  let current = resolve(cwd)
  while (true) {
    if (await exists(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return resolve(cwd)
    current = parent
  }
}

/**
 * Resolve `<dshHome>/skills`.
 * @returns the absolute global skill root.
 */
export function globalSkillRoot(): string {
  const configured = process.env.DSH_HOME
  const home = configured !== undefined && configured !== '' ? expandHome(configured) : join(homedir(), '.dsh')
  return join(resolve(home), 'skills')
}

/**
 * Resolve `<agentsHome>/skills`.
 * @returns the absolute agents skill root.
 */
export function agentsSkillRoot(): string {
  const home = process.env.DSH_AGENTS_HOME
  return join(resolve(home !== undefined && home !== '' ? home : join(homedir(), '.agents')), 'skills')
}

/**
 * Build the six scan roots for one project.
 * @param projectRoot - git root, or the workspace cwd.
 * @param customSkillDirs - host `customSkillDirs`, read only.
 * @param bundledSkillDir - host bundled root, read only. Omitted when unset.
 * @returns roots in rank order.
 */
export function skillRoots(
  projectRoot: string,
  customSkillDirs: readonly string[],
  bundledSkillDir: string | undefined,
): SkillRoot[] {
  const roots: SkillRoot[] = [
    { path: join(projectRoot, '.dsh', 'skills'), rank: 100, scope: 'project' },
    { path: join(projectRoot, '.agents', 'skills'), rank: 200, scope: 'project' },
    ...customSkillDirs.map((path) => ({ path: resolve(path), rank: 300, scope: 'custom' as const })),
    { path: globalSkillRoot(), rank: 400, scope: 'global', skipSystem: true },
    { path: agentsSkillRoot(), rank: 500, scope: 'global' },
  ]
  if (bundledSkillDir !== undefined && bundledSkillDir !== '') {
    roots.push({ path: resolve(bundledSkillDir), rank: 600, scope: 'bundled' })
  }
  return roots
}

/**
 * Scan roots and keep only the lowest-rank copy of each name.
 * @param roots - layers to read, direct children only.
 * @returns winning skills, lowest rank first.
 */
export async function scanSkills(roots: readonly SkillRoot[]): Promise<SkillView[]> {
  const found: SkillView[] = []
  for (const root of roots) {
    for (const skill of await scanRoot(root)) found.push(skill)
  }
  const byName = new Map<string, SkillView[]>()
  for (const skill of found) {
    const group = byName.get(skill.name) ?? []
    group.push(skill)
    byName.set(skill.name, group)
  }
  const winners: SkillView[] = []
  for (const group of byName.values()) {
    group.sort((left, right) => left.rank - right.rank)
    const winner = group[0]
    if (winner === undefined) continue
    const covered = group[1]
    winners.push(covered === undefined ? winner : { ...winner, shadowedBy: covered.sourceDir })
  }
  winners.sort((left, right) => left.rank - right.rank || left.name.localeCompare(right.name))
  return winners
}

/**
 * List installable directories under `<projectRoot>/skills`.
 * @param projectRoot - repository root.
 * @returns direct child skill directories with a valid name.
 */
export async function listInstallCandidates(projectRoot: string): Promise<SkillCandidate[]> {
  const root = join(projectRoot, 'skills')
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error) {
    if (isAbsent(error)) return []
    throw error
  }
  const candidates: SkillCandidate[] = []
  for (const entry of entries) {
    const sourceDir = join(root, entry.name)
    const info = await follow(sourceDir)
    if (info === undefined || !info.isDirectory()) continue
    if (!SKILL_NAME.test(entry.name)) continue
    const file = join(sourceDir, 'SKILL.md')
    const raw = await readText(file)
    if (raw === undefined) continue
    const parsed = readSkillMeta(raw, file)
    if (parsed === undefined || parsed.name !== entry.name) continue
    candidates.push({ name: parsed.name, sourceDir, description: parsed.description })
  }
  candidates.sort((left, right) => left.name.localeCompare(right.name))
  return candidates
}

/**
 * Copy a skill directory into a writable root.
 * @param sourceDir - directory that contains `SKILL.md`.
 * @param scope - `project` writes rank 100, `global` writes rank 400.
 * @param projectRoot - git root used when `scope` is `project`.
 * @returns the installed directory.
 */
export async function installSkill(
  sourceDir: string,
  scope: 'project' | 'global',
  projectRoot: string,
): Promise<{ name: string, sourceDir: string }> {
  const source = resolve(sourceDir)
  const info = await follow(source)
  if (info === undefined || !info.isDirectory()) throw new SkillError(400, '来源目录不存在')
  if (!SKILL_NAME.test(basenameOf(source))) throw new SkillError(400, '技能目录名必须是 kebab-case')
  const raw = await readText(join(source, 'SKILL.md'))
  if (raw === undefined) throw new SkillError(400, '来源目录缺少 SKILL.md')
  const parsed = readSkillMeta(raw, join(source, 'SKILL.md'))
  if (parsed === undefined) throw new SkillError(400, 'SKILL.md 无法解析')
  if (parsed.name !== basenameOf(source)) throw new SkillError(400, '目录名与 frontmatter name 不一致')
  const targetRoot = scope === 'project' ? join(projectRoot, '.dsh', 'skills') : globalSkillRoot()
  const target = join(targetRoot, parsed.name)
  if (resolve(source) === resolve(target)) throw new SkillError(409, 'already-installed')
  if (await exists(target)) throw new SkillError(409, 'already-installed')
  await mkdir(targetRoot, { recursive: true })
  await cp(source, target, { recursive: true })
  return { name: parsed.name, sourceDir: target }
}

/** One file from the upload form. */
export interface UploadedPart {
  /** Multipart filename, which may include the relative folder path. */
  name: string
  /** Raw bytes. */
  bytes: Uint8Array
}

const MAX_UPLOAD_BYTES = 32 * 1024 * 1024

/**
 * Install a skill from an uploaded folder or archive.
 * @param parts - archive as one part, or the folder's files.
 * @param scope - `project` writes rank 100, `global` writes rank 400.
 * @param projectRoot - git root used when `scope` is `project`.
 * @returns the installed directory.
 */
export async function installFromUpload(
  parts: readonly UploadedPart[],
  scope: 'project' | 'global',
  projectRoot: string,
): Promise<{ name: string, sourceDir: string }> {
  if (parts.length === 0) throw new SkillError(400, '没有收到文件')
  const total = parts.reduce((sum, part) => sum + part.bytes.byteLength, 0)
  if (total > MAX_UPLOAD_BYTES) throw new SkillError(400, '文件过大')
  const scratch = await mkdtemp(join(tmpdir(), 'dsh-skill-upload-'))
  try {
    const only = parts.length === 1 ? parts[0] : undefined
    if (only !== undefined && isArchiveName(only.name)) await extractArchive(only.bytes, only.name, scratch)
    else {
      for (const part of parts) await writeSafe(scratch, part.name, part.bytes)
    }
    return await installSkill(await findUploadedSkill(scratch), scope, projectRoot)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

/**
 * Turn a skill on or off by editing the two invocation lines.
 * @param sourceDir - winning `sourceDir` from the catalog.
 * @param enabled - true removes both lines; false writes both off switches.
 * @param projectRoot - git root, used to recognize the writable project layer.
 */
export async function toggleSkill(sourceDir: string, enabled: boolean, projectRoot: string): Promise<void> {
  const file = await resolveSkillFile(sourceDir)
  if (file === undefined) throw new SkillError(404, '找不到 SKILL.md')
  if (!isWritableSkill(file, projectRoot)) throw new SkillError(403, '这一层只读，不能改开关')
  const raw = await readFile(file, 'utf8')
  const next = rewriteInvocation(raw, enabled)
  if (next === undefined) throw new SkillError(400, 'SKILL.md 没有合法的 frontmatter')
  await writeFile(file, next, 'utf8')
}

/** HTTP-shaped failure from install or toggle. */
export class SkillError extends Error {
  /** Status to return to the browser. */
  readonly status: number

  /**
   * @param status - HTTP status.
   * @param message - client-visible reason. `already-installed` is the 409 token.
   */
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/**
 * Rewrite invocation lines without touching the body or other fields.
 * @param raw - full markdown file.
 * @param enabled - true deletes the two keys; false writes both off.
 * @returns the new file, or `undefined` when frontmatter is missing.
 */
export function rewriteInvocation(raw: string, enabled: boolean): string | undefined {
  const located = locateFrontmatter(raw)
  if (located === undefined) return undefined
  const kept = located.yaml.split(/\r?\n/).filter((line) => !isInvocationLine(line))
  while (kept.length > 0 && kept[kept.length - 1]?.trim() === '') kept.pop()
  if (!enabled) kept.push('disable-model-invocation: true', 'user-invocable: false')
  const yaml = kept.length === 0 ? '' : `${kept.join(located.newline)}${located.newline}`
  return `${located.head}${yaml}${located.tail}`
}

async function scanRoot(root: SkillRoot): Promise<SkillView[]> {
  let entries
  try {
    entries = await readdir(root.path, { withFileTypes: true })
  } catch (error) {
    if (isAbsent(error)) return []
    console.error(`dsh-sidebar: skill root ${root.path} ignored: ${errorText(error)}`)
    return []
  }
  const skills: SkillView[] = []
  for (const entry of entries) {
    if (root.skipSystem === true && entry.name === '.system') continue
    const full = join(root.path, entry.name)
    const info = await follow(full)
    if (info === undefined) continue
    if (info.isDirectory()) {
      if (!SKILL_NAME.test(entry.name)) continue
      const file = join(full, 'SKILL.md')
      const skill = await readSkillView(file, full, root)
      if (skill !== undefined) skills.push(skill)
      continue
    }
    if (!info.isFile() || !entry.name.endsWith('.md')) continue
    const flatName = entry.name.slice(0, -3)
    if (!SKILL_NAME.test(flatName)) continue
    const skill = await readSkillView(full, full, root)
    if (skill !== undefined) skills.push(skill)
  }
  return skills
}

async function readSkillView(file: string, sourceDir: string, root: SkillRoot): Promise<SkillView | undefined> {
  const raw = await readText(file)
  if (raw === undefined) return undefined
  const parsed = readSkillMeta(raw, file)
  if (parsed === undefined) return undefined
  return {
    name: parsed.name,
    description: parsed.description,
    rank: root.rank,
    scope: root.scope,
    sourceDir,
    enabled: parsed.enabled,
  }
}

function readSkillMeta(raw: string, file: string): { name: string, description: string, enabled: boolean } | undefined {
  const located = locateFrontmatter(raw)
  if (located === undefined) {
    console.error(`dsh-sidebar: skill file ${file} ignored: missing YAML frontmatter`)
    return undefined
  }
  let fields: Map<string, string | boolean>
  try {
    fields = parseFields(located.yaml)
  } catch (error) {
    console.error(`dsh-sidebar: skill file ${file} ignored: invalid YAML frontmatter: ${errorText(error)}`)
    return undefined
  }
  const name = textField(fields, 'name')
  const description = textField(fields, 'description')
  if (name === undefined || description === undefined) {
    console.error(`dsh-sidebar: skill file ${file} ignored: frontmatter requires name and description`)
    return undefined
  }
  if (!SKILL_NAME.test(name)) {
    console.error(`dsh-sidebar: skill file ${file} ignored: invalid skill name "${name}"`)
    return undefined
  }
  const disableModel = fields.get('disable-model-invocation')
  const userInvocable = fields.get('user-invocable')
  const enabled = disableModel !== true && userInvocable !== false
  return {
    name,
    description: description.length > DESCRIPTION_LIMIT ? description.slice(0, DESCRIPTION_LIMIT) : description,
    enabled,
  }
}

function parseFields(yaml: string): Map<string, string | boolean> {
  const fields = new Map<string, string | boolean>()
  const lines = yaml.split(/\r?\n/)
  let index = 0
  while (index < lines.length) {
    const line = lines[index] ?? ''
    if (line.trim() === '' || line.trimStart().startsWith('#')) {
      index += 1
      continue
    }
    const matched = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (matched === null) {
      index += 1
      continue
    }
    const key = matched[1] ?? ''
    const rest = (matched[2] ?? '').trim()
    if (rest === '|' || rest === '|-' || rest === '|+' || rest === '>' || rest === '>-' || rest === '>+') {
      const block: string[] = []
      index += 1
      while (index < lines.length) {
        const next = lines[index] ?? ''
        if (next !== '' && !next.startsWith(' ') && !next.startsWith('\t')) break
        block.push(next.trim())
        index += 1
      }
      const joiner = rest.startsWith('>') ? ' ' : '\n'
      fields.set(key, block.filter((item) => item !== '').join(joiner))
      continue
    }
    fields.set(key, coerceScalar(rest))
    index += 1
  }
  return fields
}

function coerceScalar(raw: string): string | boolean {
  const unquoted = unquote(raw)
  if (unquoted === raw.trim()) {
    const folded = unquoted.toLowerCase()
    if (folded === 'true' || folded === 'yes' || folded === 'on') return true
    if (folded === 'false' || folded === 'no' || folded === 'off') return false
  }
  return unquoted
}

function unquote(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith('\'') && trimmed.endsWith('\''))
  ) return trimmed.slice(1, -1)
  return trimmed
}

function textField(fields: Map<string, string | boolean>, key: string): string | undefined {
  const value = fields.get(key)
  return typeof value === 'string' && value !== '' ? value : undefined
}

function locateFrontmatter(raw: string): { head: string, yaml: string, tail: string, newline: '\n' | '\r\n' } | undefined {
  const newline = raw.includes('\r\n') ? '\r\n' : '\n'
  const firstBreak = raw.indexOf('\n')
  if (firstBreak < 0) return undefined
  if (raw.slice(0, firstBreak).replace(/\r$/, '') !== '---') return undefined
  const yamlStart = firstBreak + 1
  let lineStart = yamlStart
  while (lineStart <= raw.length) {
    const nextBreak = raw.indexOf('\n', lineStart)
    const lineEnd = nextBreak < 0 ? raw.length : nextBreak
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return {
        head: raw.slice(0, yamlStart),
        yaml: raw.slice(yamlStart, lineStart),
        tail: raw.slice(lineStart),
        newline,
      }
    }
    if (nextBreak < 0) return undefined
    lineStart = nextBreak + 1
  }
  return undefined
}

function isInvocationLine(line: string): boolean {
  const matched = /^[ \t]*["']?([A-Za-z0-9_-]+)["']?\s*:/.exec(line)
  return matched !== null && INVOCATION_KEYS.has(matched[1] ?? '')
}

async function resolveSkillFile(sourceDir: string): Promise<string | undefined> {
  const target = resolve(sourceDir)
  if (target.endsWith('.md')) return await exists(target) ? target : undefined
  const nested = join(target, 'SKILL.md')
  return await exists(nested) ? nested : undefined
}

function isWritableSkill(file: string, projectRoot: string): boolean {
  const resolved = resolve(file)
  return isInside(resolved, join(projectRoot, '.dsh', 'skills'))
    || isInside(resolved, globalSkillRoot())
}

function isInside(file: string, root: string): boolean {
  const base = resolve(root)
  return file === base || file.startsWith(base.endsWith(sep) ? base : base + sep)
}

function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

function basenameOf(path: string): string {
  const parts = path.split(sep)
  return parts[parts.length - 1] ?? path
}

async function follow(path: string): Promise<{ isDirectory(): boolean, isFile(): boolean } | undefined> {
  try {
    return await stat(path)
  } catch (error) {
    if (isAbsent(error)) return undefined
    console.error(`dsh-sidebar: skill entry ${path} ignored: ${errorText(error)}`)
    return undefined
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (isAbsent(error)) return undefined
    console.error(`dsh-sidebar: skill file ${path} ignored: ${errorText(error)}`)
    return undefined
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isAbsent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error.code === 'ENOENT' || error.code === 'ENOTDIR')
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Guard so a relative path cannot be treated as a project root. */
export function assertAbsolute(path: string): string {
  if (!isAbsolute(path)) throw new SkillError(400, '路径必须是绝对路径')
  return resolve(path)
}

function isArchiveName(name: string): boolean {
  const lower = name.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  return lower.endsWith('.zip') || lower.endsWith('.tar.gz') || lower.endsWith('.tgz') || lower.endsWith('.tar')
}

function safeRelative(raw: string): string | undefined {
  const normalized = raw.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/^\/+/, '')
  if (normalized === '' || normalized.includes('\0')) return undefined
  const parts = normalized.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) return undefined
  return parts.join('/')
}

async function writeSafe(dest: string, name: string, bytes: Uint8Array): Promise<void> {
  const relative = safeRelative(name)
  if (relative === undefined) throw new SkillError(400, '文件路径不合法')
  if (relative.split('/').includes('__MACOSX') || relative.endsWith('.DS_Store')) return
  const target = join(dest, relative)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
}

async function findUploadedSkill(root: string): Promise<string> {
  const files: string[] = []
  await collectSkillFiles(root, files)
  if (files.length === 0) throw new SkillError(400, '找不到 SKILL.md')
  const ranked = files.map((file) => ({ file, depth: dirname(file).split(sep).length }))
  ranked.sort((left, right) => left.depth - right.depth)
  const top = ranked[0]?.depth
  const dirs = [...new Set(ranked.filter((item) => item.depth === top).map((item) => dirname(item.file)))]
  if (dirs.length !== 1) throw new SkillError(400, '一次只能安装一个技能')
  const dir = dirs[0]
  if (dir === undefined) throw new SkillError(400, '找不到 SKILL.md')
  if (resolve(dir) === resolve(root)) return relocateRootSkill(root)
  return dir
}

async function collectSkillFiles(dir: string, out: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === '__MACOSX' || entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectSkillFiles(full, out)
    else if (entry.isFile() && entry.name === 'SKILL.md') out.push(full)
  }
}

async function relocateRootSkill(root: string): Promise<string> {
  const file = join(root, 'SKILL.md')
  const raw = await readText(file)
  if (raw === undefined) throw new SkillError(400, '找不到 SKILL.md')
  const parsed = readSkillMeta(raw, file)
  if (parsed === undefined || !SKILL_NAME.test(parsed.name)) throw new SkillError(400, 'SKILL.md 无法解析')
  const named = join(root, parsed.name)
  await mkdir(named)
  for (const entry of await readdir(root)) {
    if (entry === parsed.name) continue
    await rename(join(root, entry), join(named, entry))
  }
  return named
}

async function extractArchive(bytes: Uint8Array, name: string, dest: string): Promise<void> {
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) {
    await extractZip(bytes, dest)
    return
  }
  if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) {
    await extractTar(gunzipSync(bytes), dest)
    return
  }
  if (lower.endsWith('.tar')) {
    await extractTar(Buffer.from(bytes), dest)
    return
  }
  throw new SkillError(400, '只支持 zip、tar、tar.gz、tgz')
}

async function extractZip(bytes: Uint8Array, dest: string): Promise<void> {
  const view = Buffer.from(bytes)
  const eocd = findEocd(view)
  if (eocd < 0) throw new SkillError(400, '压缩包无法解析')
  const count = view.readUInt16LE(eocd + 10)
  let cursor = view.readUInt32LE(eocd + 16)
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > view.length || view.readUInt32LE(cursor) !== 0x02014b50) throw new SkillError(400, '压缩包无法解析')
    const method = view.readUInt16LE(cursor + 10)
    const compSize = view.readUInt32LE(cursor + 20)
    const rawSize = view.readUInt32LE(cursor + 24)
    const nameLen = view.readUInt16LE(cursor + 28)
    const extraLen = view.readUInt16LE(cursor + 30)
    const commentLen = view.readUInt16LE(cursor + 32)
    const local = view.readUInt32LE(cursor + 42)
    const name = view.toString('utf8', cursor + 46, cursor + 46 + nameLen)
    cursor += 46 + nameLen + extraLen + commentLen
    if (name.endsWith('/') || name.endsWith('\\')) continue
    if (compSize > MAX_UPLOAD_BYTES || rawSize > MAX_UPLOAD_BYTES) throw new SkillError(400, '压缩包过大')
    total += rawSize
    if (total > MAX_UPLOAD_BYTES) throw new SkillError(400, '压缩包过大')
    if (local + 30 > view.length || view.readUInt32LE(local) !== 0x04034b50) throw new SkillError(400, '压缩包无法解析')
    const dataStart = local + 30 + view.readUInt16LE(local + 26) + view.readUInt16LE(local + 28)
    const compressed = view.subarray(dataStart, dataStart + compSize)
    const raw = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : undefined
    if (raw === undefined) throw new SkillError(400, '压缩包使用了不支持的压缩方式')
    await writeSafe(dest, name, raw)
  }
}

function findEocd(view: Buffer): number {
  if (view.length < 22) return -1
  const start = Math.max(0, view.length - 22 - 0xffff)
  for (let offset = view.length - 22; offset >= start; offset -= 1) {
    if (view.readUInt32LE(offset) === 0x06054b50) return offset
  }
  return -1
}

async function extractTar(view: Buffer, dest: string): Promise<void> {
  let offset = 0
  let total = 0
  let longName: string | undefined
  while (offset + 512 <= view.length) {
    if (view.subarray(offset, offset + 512).every((byte) => byte === 0)) break
    const headerName = tarString(view, offset, 100)
    const magic = tarString(view, offset + 257, 5)
    const prefix = magic === 'ustar' ? tarString(view, offset + 345, 155) : ''
    const name = longName ?? (prefix === '' ? headerName : `${prefix}/${headerName}`)
    longName = undefined
    const size = Number.parseInt(tarString(view, offset + 124, 12).trim(), 8)
    const type = view[offset + 156] ?? 0
    offset += 512
    const bytes = Number.isFinite(size) && size > 0 ? size : 0
    const data = view.subarray(offset, offset + bytes)
    offset += Math.ceil(bytes / 512) * 512
    if (type === 76) {
      longName = data.toString('utf8').replace(/\0.*/, '')
      continue
    }
    if (name.endsWith('/') || type === 53) continue
    if (type !== 0 && type !== 48) continue
    if (!Number.isFinite(size) || size < 0 || size > MAX_UPLOAD_BYTES) throw new SkillError(400, '压缩包过大')
    total += size
    if (total > MAX_UPLOAD_BYTES) throw new SkillError(400, '压缩包过大')
    await writeSafe(dest, name, data)
  }
}

function tarString(view: Buffer, start: number, length: number): string {
  const slice = view.subarray(start, start + length)
  const end = slice.indexOf(0)
  return slice.toString('utf8', 0, end === -1 ? slice.length : end)
}
