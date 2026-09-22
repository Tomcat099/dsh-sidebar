/**
 * Backend selection: turns one resolved configuration into the provider the
 * rest of the plugin talks to, and reports why a backend is unusable.
 */

import { memoryConfigComplaint, resolveMemoryDb, type MemoryConfig } from './config.js'
import { createEmbedder, type Embedder, type EmbeddingHooks } from './embedding.js'
import { LocalMemoryProvider } from './local.js'
import { HttpMemoryProvider, McpMemoryProvider, type RemoteSettings } from './remote.js'
import type { MemoryProvider } from './types.js'

/** The provider for one configuration, or the reason there is none. */
export interface ProviderHandle {
  /** Ready backend; absent when the configuration cannot serve requests. */
  provider?: MemoryProvider
  /** User-facing reason the backend is unavailable. */
  complaint?: string
  /** Identity of the inputs that produced this handle, used for reuse. */
  signature: string
}

/**
 * Fingerprint the fields that force a new backend.
 * @param config - resolved configuration.
 * @returns a stable string.
 */
export function providerSignature(config: MemoryConfig): string {
  return JSON.stringify([
    config.mode,
    config.localDir,
    config.localDb,
    config.embeddingEnabled,
    config.embeddingBaseURL,
    config.embeddingApiKey,
    config.embeddingModel,
    config.embeddingDim,
    config.externalKind,
    config.externalBaseURL,
    config.externalApiKey,
    config.externalNamespace,
    config.externalSearchTool,
    config.externalWriteTool,
  ])
}

/**
 * Project the embedding endpoint settings.
 * @param config - resolved configuration.
 * @returns the embedder settings.
 */
function embeddingSettings(config: MemoryConfig): Parameters<typeof createEmbedder>[0] {
  return {
    enabled: config.embeddingEnabled,
    baseURL: config.embeddingBaseURL,
    apiKey: config.embeddingApiKey,
    model: config.embeddingModel,
    dim: config.embeddingDim,
  }
}

/**
 * Project the remote endpoint settings.
 * @param config - resolved configuration.
 * @returns the remote settings.
 */
function remoteSettings(config: MemoryConfig): RemoteSettings {
  return {
    baseURL: config.externalBaseURL,
    apiKey: config.externalApiKey,
    namespace: config.externalNamespace,
    searchTool: config.externalSearchTool,
    writeTool: config.externalWriteTool,
  }
}

/**
 * Build the backend for one configuration.
 * @param config - resolved configuration.
 * @param hooks - embedding observation callbacks.
 * @returns the handle; `provider` is absent when the configuration is incomplete.
 */
export function createProvider(config: MemoryConfig, hooks: EmbeddingHooks = {}): ProviderHandle {
  const signature = providerSignature(config)
  const complaint = memoryConfigComplaint(config)
  if (complaint !== undefined) return { signature, complaint }
  if (config.mode === 'external') {
    return {
      signature,
      provider: config.externalKind === 'mcp'
        ? new McpMemoryProvider(remoteSettings(config))
        : new HttpMemoryProvider(remoteSettings(config)),
    }
  }
  let embedder: Embedder | undefined
  try {
    embedder = createEmbedder(embeddingSettings(config), hooks)
  } catch (error) {
    return { signature, complaint: error instanceof Error ? error.message : String(error) }
  }
  try {
    return {
      signature,
      provider: new LocalMemoryProvider({
        dbPath: resolveMemoryDb(config),
        ...(embedder === undefined ? {} : { embedder }),
      }),
    }
  } catch (error) {
    return { signature, complaint: error instanceof Error ? error.message : String(error) }
  }
}
