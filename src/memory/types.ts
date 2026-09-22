/**
 * Shared memory value types and the provider contract.
 *
 * Every backend (SQLite, Mem0-style REST, MCP tools) implements
 * {@link MemoryProvider} so the rest of the plugin never branches on storage.
 */

/** One durable fact. */
export interface MemoryEntry {
  /** Backend-assigned id. */
  id: string
  /** Short taxonomy such as `preference`, `fact`, `decision`. */
  kind: string
  /** The fact itself, one sentence. */
  content: string
  /** Free-form labels. */
  tags: string[]
  /** Session the fact was extracted from, when known. */
  sourceSession?: string
  /** Workspace path the fact belongs to, when known. */
  sourceWorkspace?: string
  /** Extraction confidence in `[0, 1]`. */
  confidence: number
  /** Creation time, epoch milliseconds. */
  createdAt: number
  /** Last write time, epoch milliseconds. */
  updatedAt: number
}

/** A memory plus the ranking facts that produced it. */
export interface MemoryHit extends MemoryEntry {
  /** Fused score; only comparable within one result set. */
  score: number
  /** Retriever names that returned this row, e.g. `vector`, `fts`, `like`. */
  sources: string[]
}

/** What to write; the backend fills ids and timestamps. */
export interface MemoryDraft {
  kind: string
  content: string
  tags?: string[]
  sourceSession?: string
  sourceWorkspace?: string
  confidence?: number
}

/** One query across a provider. */
export interface MemoryQuery {
  text: string
  topK: number
  fusion: 'rrf' | 'vector' | 'fulltext'
}

/** Listing filters for the toolbox page. */
export interface MemoryListOptions {
  text?: string
  limit: number
  offset: number
}

/** Reachability report shown in the settings card and toolbox page. */
export interface MemoryHealth {
  ok: boolean
  kind: 'local' | 'http' | 'mcp'
  detail: string
}

/** One candidate produced by a single retriever before fusion. */
export interface RankedCandidate {
  id: string
  score: number
}

/** Named result list fed into fusion. */
export interface RankedList {
  name: string
  candidates: RankedCandidate[]
}

/** Storage backend behind the memory feature. */
export interface MemoryProvider {
  readonly kind: 'local' | 'http' | 'mcp'
  /** Probe the backend without mutating it. */
  health(): Promise<MemoryHealth>
  /** Insert one memory; duplicates collapse onto the existing row. */
  write(draft: MemoryDraft): Promise<{ id: string, created: boolean }>
  /** Search memories. */
  search(query: MemoryQuery): Promise<MemoryHit[]>
  /** Paginated listing for the management UI. */
  list(options: MemoryListOptions): Promise<MemoryHit[]>
  /** Patch one memory's mutable fields. */
  update(id: string, patch: Partial<MemoryDraft>): Promise<void>
  /** Remove one memory. */
  remove(id: string): Promise<void>
  /** Total live memories. */
  count(): Promise<number>
  /** Rebuild every stored vector; absent for backends that own their index. */
  reembedAll?(): Promise<{ updated: number, failed: number }>
  /** Merge memories that describe the same fact; absent for remote backends. */
  dedupe?(): Promise<{ removed: number }>
  /** Release native resources; optional because remote backends hold none. */
  close?(): void
}
