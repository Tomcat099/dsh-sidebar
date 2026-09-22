/**
 * Recall injection: what the model is told about remembered facts before a
 * step.
 *
 * Two layers, following the layered design the reference systems use:
 * - a standing block of stable preferences and conventions, valid in every
 *   conversation and available on its very first turn;
 * - a per-session block of facts matching what that conversation is about.
 *
 * The prompt assembler renders synchronously, so both blocks are cached.
 */

import type { MemoryHit } from './types.js'

/** Runtime-context entry name registered with `ctx.systemPrompt`. */
export const RECALL_CONTEXT_NAME = 'dsh-sidebar-memory'

/** Placement among runtime contexts; late enough to trail the harness facts. */
export const RECALL_ORDER = 900

/** Character budget for the query-matched block. */
export const RECALL_BUDGET = 2_000

/** Character budget for the always-on block. */
export const STANDING_BUDGET = 1_200

/** Kinds that describe durable preferences rather than one conversation. */
const STANDING_KINDS = new Set(['preference', 'convention'])

/** Most standing facts considered for injection. */
export const STANDING_LIMIT = 20

/** Entries kept per session cache. */
const SESSION_LIMIT = 8

/**
 * Render one list of memories as Markdown bullets.
 * @param hits - memories to render.
 * @param budget - character budget for the bullet list.
 * @param now - current time, used for relative ages.
 * @returns the bullet lines.
 */
function renderLines(hits: MemoryHit[], budget: number, now: number): string[] {
  const lines: string[] = []
  let used = 0
  for (const hit of hits) {
    const line = `- [${hit.kind}] ${hit.content}${hit.tags.length === 0 ? '' : `（${hit.tags.join('/')}）`} · ${formatAge(hit.updatedAt, now)}`
    if (used + line.length > budget) break
    used += line.length
    lines.push(line)
  }
  return lines
}

/**
 * Render the query-matched block.
 * @param hits - ranked memories.
 * @param now - current time, used for relative ages.
 * @returns Markdown, or `''` when there is nothing to inject.
 */
export function renderRecallBlock(hits: MemoryHit[], now = Date.now()): string {
  const lines = renderLines(hits, RECALL_BUDGET, now)
  if (lines.length === 0) return ''
  return ['## 相关记忆（来自记忆库，仅供参考；与当前对话冲突时以当前对话为准）', ...lines].join('\n')
}

/**
 * Render the always-on block of stable preferences.
 * @param hits - preference and convention memories, newest first.
 * @param now - current time, used for relative ages.
 * @returns Markdown, or `''` when there is nothing to inject.
 */
export function renderStandingBlock(hits: MemoryHit[], now = Date.now()): string {
  const lines = renderLines(hits, STANDING_BUDGET, now)
  if (lines.length === 0) return ''
  return [
    '## 用户长期偏好（记忆库中跨会话保留的稳定信息，任何时候都成立）',
    ...lines,
  ].join('\n')
}

/**
 * Pick the memories worth keeping always on.
 * @param hits - candidate memories, newest first.
 * @returns the standing subset.
 */
export function standingHits(hits: MemoryHit[]): MemoryHit[] {
  return hits.filter((hit) => STANDING_KINDS.has(hit.kind)).slice(0, STANDING_LIMIT)
}

/**
 * Format a memory age for the injected list.
 * @param updatedAt - last write time.
 * @param now - current time.
 * @returns a short age label.
 */
function formatAge(updatedAt: number, now: number): string {
  const days = Math.floor(Math.max(0, now - updatedAt) / 86_400_000)
  if (days === 0) return '今天'
  if (days < 30) return `${String(days)}天前`
  return `${String(Math.floor(days / 30))}个月前`
}

/**
 * Cached blocks: one always-on block plus one per session.
 *
 * A turn's system prompt is assembled the moment its user message arrives,
 * before any asynchronous lookup can finish, which is why the standing block
 * cannot depend on the current question.
 */
export class RecallCache {
  private readonly blocks = new Map<string, string>()
  private standing = ''

  /**
   * Replace the always-on block.
   * @param hits - preference and convention memories.
   */
  setStanding(hits: MemoryHit[]): void {
    this.standing = renderStandingBlock(standingHits(hits))
  }

  /**
   * Replace one session's block.
   * @param sessionId - session identity; `''` for the fallback slot.
   * @param hits - ranked memories for that session.
   */
  set(sessionId: string, hits: MemoryHit[]): void {
    const key = sessionId === '' ? '\u0000fallback' : sessionId
    this.blocks.delete(key)
    this.blocks.set(key, renderRecallBlock(hits))
    while (this.blocks.size > SESSION_LIMIT) {
      const oldest = this.blocks.keys().next().value
      if (oldest === undefined) break
      this.blocks.delete(oldest)
    }
  }

  /**
   * Read the injected text for one session.
   *
   * A named session that has no block yet gets the standing layer only: another
   * conversation's matches must never leak into it. When the assembler exposes
   * no session identity at all, the newest block is the best available guess.
   * @param sessionId - session identity, when the prompt assembler exposes it.
   * @returns standing plus session blocks, or `''` when nothing is known yet.
   */
  get(sessionId?: string): string {
    let session = ''
    if (sessionId !== undefined && sessionId !== '') {
      session = this.blocks.get(sessionId) ?? ''
    } else {
      session = this.blocks.get('\u0000fallback') ?? ''
      if (session === '') {
        for (const value of this.blocks.values()) session = value
      }
    }
    if (this.standing === '') return session
    if (session === '') return this.standing
    return `${this.standing}\n\n${session}`
  }

  /** Forget every cached block, keeping nothing stale across a config change. */
  clear(): void {
    this.blocks.clear()
    this.standing = ''
  }

  /**
   * Report what would be injected right now.
   * @returns character count of the standing block and the number of session blocks.
   */
  stats(): { standingChars: number, sessions: number } {
    return { standingChars: this.standing.length, sessions: this.blocks.size }
  }
}
