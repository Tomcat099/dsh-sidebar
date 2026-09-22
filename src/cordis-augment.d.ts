/**
 * Local stand-in so the host entry compiles without a DSH checkout.
 * The runtime resolves Cordis through the profile's own dependency graph.
 */
declare module '@deepseek-ai/cordis' {
  /** Minimal structural view of one host session. */
  export interface HostSessionLike {
    id?: unknown
    header?: { cwd?: unknown }
    snapshotEvents?(): Array<{ seq: number, type: string, data?: unknown }>
  }

  /** Minimal structural view of one live agent. */
  export interface HostAgentLike {
    status?: unknown
    session?: HostSessionLike
  }

  /** Minimal structural view of the host context. */
  export interface Context {
    /** Scoped effect registration; the disposer runs on unload. */
    effect(callback: () => (() => void | Promise<void>), label?: string): void
    /** Wait for services, then run the callback with the scoped context. */
    inject(services: string[], callback: (scoped: Context) => void): void
    /** Authenticated fetch routes provided by the host connection. */
    connection: {
      fetch: {
        register(route: {
          path: string
          methods: string[]
          requestBody: 'buffered'
          fetch: (request: {
            signal: AbortSignal
            url: string
            json: () => Promise<unknown>
            formData?: () => Promise<{
              get(name: string): unknown
              getAll(name: string): unknown[]
            }>
          }) => Promise<Response>
        }): void
      }
    }
    /** Host workspace registry used to adopt a prepared directory. */
    workspaceRegistry: {
      create(path: string, title: string): Promise<unknown>
      list(): Array<{ path: string }>
    }
    /** HTTP route registry used by the MCP settings page. */
    webServer: {
      register(route: {
        kind: 'exact' | 'prefix'
        path: string
        handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void | Promise<void>
      }): () => void
    }
    /** Mount a child plugin; the handle exposes `await()` and `dispose()`. */
    plugin(plugin: unknown, config?: unknown): {
      await(): Promise<void>
      dispose(): Promise<void> | void
    }
    /** Namespaced logger. */
    logger: { warn(message: string, ...args: unknown[]): void }
    /** Live plugin fibers, used to read the host skill-filesystem config. */
    registry: {
      values(): Iterable<{
        name?: string
        fibers: Iterable<{ config: unknown }>
      }>
    }
    /** Service lookup for optional seams; the memory feature guards each one. */
    get?(name: string): any
    /** Host event subscription; returns the disposer when one is provided. */
    on?(event: string, listener: (...args: any[]) => void): unknown
    /** Settings provider used by the plugin configuration card. */
    settings?: {
      installSection(
        owner: Context,
        ns: string,
        schema: unknown,
        entry: unknown,
        hooks: {
          setSource(source: () => unknown): void
          onChange(): void
          validate?(value: unknown): void
        },
      ): unknown
    }
    /** Agent tool registry. */
    tools?: {
      register(tool: unknown): void
    }
    /** Assembled system prompt, including dynamic runtime contexts. */
    systemPrompt?: {
      context(entry: { name: string, order: number, text: string | ((context: unknown) => string) }): unknown
      getContextOrder(name: string): number
    }
    /** Live agent registry, used to drive memory sweeps. */
    agents?: {
      list?(): HostAgentLike[]
      roots?(): HostAgentLike[]
    }
    /** Model runtime used for auxiliary completions. */
    llm?: {
      stream(options: Record<string, unknown>): AsyncIterable<unknown>
      listProviders?(): Array<{ id?: string, models?: Array<{ id: string }> }>
    }
  }
}

declare module '@deepseek-ai/schemastery' {
  /** Chainable schema node, narrowed to the calls this plugin makes. */
  export interface SchemaNode<T = unknown> {
    default(value: T): SchemaNode<T>
    role(name: string): SchemaNode<T>
    step(value: number): SchemaNode<T>
    min(value: number): SchemaNode<T>
    max(value: number): SchemaNode<T>
  }

  /** Schema root. */
  export interface SchemaRoot {
    object(shape: Record<string, unknown>): SchemaNode<Record<string, unknown>>
    boolean(): SchemaNode<boolean>
    string(): SchemaNode<string>
    number(): SchemaNode<number>
    const<T>(value: T): SchemaNode<T>
    union(list: unknown[]): SchemaNode<unknown>
  }

  const z: SchemaRoot
  export default z
}

declare module '@deepseek-ai/dsh-llm' {
  /**
   * Build one user message.
   * @param input - content blocks and provenance.
   * @returns the message value handed to `llm.stream`.
   */
  export function createUserMessage(input: {
    content: Array<{ type: 'text', text: string }>
    source: { kind: 'plugin', plugin: string }
  }): unknown

  /** Accumulates streamed chunks into complete content blocks. */
  export class BlockAssembler {
    /** Add one streamed chunk. */
    push(chunk: unknown): void
    /** Completed blocks, in stream order. */
    blocks(): Array<{ type: string, text?: string }>
  }
}

declare module '@deepseek-ai/dsh-home-paths' {
  /**
   * Resolve a directory under the active DSH home.
   * @param parts - path segments below the home directory.
   * @returns the absolute directory.
   */
  export function dshHomePath(...parts: string[]): string
}

