/**
 * Agent-facing memory tools.
 *
 * Definitions are plain objects in the compiled shape the tool registry
 * expects: a JSON-Schema `parameters` object, an `output.render` producing
 * content blocks, and an `execute` returning the declared output value.
 */

import type { MemoryHit, MemoryProvider } from './types.js'

/** Text of one rendered hit. */
function hitLine(hit: MemoryHit): string {
  return `- [${hit.kind}] ${hit.content}${hit.tags.length === 0 ? '' : `（${hit.tags.join('/')}）`} · id=${hit.id}`
}

/**
 * Render hits for the model.
 * @param hits - ranked memories.
 * @returns Markdown lines, or a "nothing found" line.
 */
export function renderHits(hits: MemoryHit[]): string {
  if (hits.length === 0) return '没有匹配的记忆。'
  return hits.map(hitLine).join('\n')
}

/** One registered tool definition. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => Array<{ type: 'text', text: string }>
  }
  timeoutMs?: number
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** Everything the tools need from the runtime. */
export interface ToolHost {
  /** Current backend, or `undefined` while the configuration is unusable. */
  provider(): MemoryProvider | undefined
  /** Reason the backend is unusable, for user-facing errors. */
  complaint(): string | undefined
  /** Current recall depth. */
  topK(): number
}

/**
 * Read one string argument.
 * @param args - tool arguments.
 * @param key - field name.
 * @returns the trimmed value, or `''` when absent.
 */
function argString(args: unknown, key: string): string {
  const value = (args as Record<string, unknown> | undefined)?.[key]
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read one string-array argument.
 * @param args - tool arguments.
 * @param key - field name.
 * @returns the values, empty when the field is not an array.
 */
function argStrings(args: unknown, key: string): string[] {
  const value = (args as Record<string, unknown> | undefined)?.[key]
  if (!Array.isArray(value)) return []
  return value.map((item) => String(item).trim()).filter((item) => item !== '')
}

/**
 * Resolve the backend or explain why there is none.
 * @param host - tool host.
 * @returns the provider.
 * @throws when the memory feature is switched off or misconfigured.
 */
function requireProvider(host: ToolHost): MemoryProvider {
  const provider = host.provider()
  if (provider === undefined) throw new Error(host.complaint() ?? '记忆功能不可用')
  return provider
}

/** Text schema shared by every tool result. */
const TEXT_OUTPUT: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    results: {
      type: 'array',
      required: true,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true },
          kind: { type: 'string', required: true },
          content: { type: 'string', required: true },
          tags: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
    },
  },
}

/**
 * Build the memory tool set.
 * @param host - runtime bindings.
 * @returns the tool definitions to register.
 */
export function memoryTools(host: ToolHost): ToolDefinition[] {
  return [
    {
      name: 'memory_search',
      description: 'Search the long-term memory store for durable facts about the user, this project, or earlier decisions. Call it before answering anything about the user\'s preferences, habits, or past choices — and never answer that you have no such information before searching. Returns matching facts with their ids.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: { type: 'string', required: true, description: 'What to look up, in natural language.' },
          topK: { type: 'integer', minimum: 1, maximum: 20, description: 'Maximum facts to return. Defaults to the configured recall depth.' },
        },
        required: ['query'],
      },
      output: {
        schema: TEXT_OUTPUT,
        render: (_args, value) => [{
          type: 'text',
          text: renderHits((value as { results: MemoryHit[] }).results),
        }],
      },
      timeoutMs: 20_000,
      async execute(args) {
        const provider = requireProvider(host)
        const query = argString(args, 'query')
        if (query === '') throw new Error('query 不能为空')
        const requested = Number((args as Record<string, unknown> | undefined)?.topK)
        const topK = Number.isFinite(requested) && requested > 0 ? Math.min(20, Math.trunc(requested)) : host.topK()
        const hits = await provider.search({ text: query, topK, fusion: 'rrf' })
        return {
          results: hits.map((hit) => ({
            id: hit.id,
            kind: hit.kind,
            content: hit.content,
            tags: hit.tags,
          })),
        }
      },
    },
    {
      name: 'memory_write',
      description: 'Store one durable fact about the user, the project, or a decision that future sessions should know — including anything the user asks you to remember. It becomes available in every later conversation. Skip temporary state and anything already stored.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: { type: 'string', required: true, description: 'One fact, one sentence, in the language of the conversation.' },
          kind: { type: 'string', description: 'One of preference, fact, decision, entity, convention. Defaults to fact.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional labels.' },
        },
        required: ['content'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true },
            created: { type: 'boolean', required: true },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: (value as { created: boolean }).created ? '已记住这条信息。' : '这条信息已在记忆中，已更新。',
        }],
      },
      timeoutMs: 20_000,
      async execute(args) {
        const provider = requireProvider(host)
        const content = argString(args, 'content')
        if (content === '') throw new Error('content 不能为空')
        const kind = argString(args, 'kind').toLowerCase() || 'fact'
        const written = await provider.write({ kind, content, tags: argStrings(args, 'tags') })
        return { id: written.id, created: written.created }
      },
    },
    {
      name: 'memory_forget',
      description: 'Delete one stored memory by id. Use it when the user asks to forget something or when a stored fact turns out to be wrong.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', required: true, description: 'Id returned by memory_search or memory_write.' },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { removed: { type: 'boolean', required: true } },
        },
        render: () => [{ type: 'text', text: '已删除。' }],
      },
      timeoutMs: 20_000,
      async execute(args) {
        const provider = requireProvider(host)
        const id = argString(args, 'id')
        if (id === '') throw new Error('id 不能为空')
        await provider.remove(id)
        return { removed: true }
      },
    },
  ]
}
