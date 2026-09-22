/**
 * Memory settings namespace, schema, and normalization.
 *
 * The browser card in 设置 → 插件 → 插件配置 and this schema are two halves of
 * one pair: the host serves the namespace through `settings.installSection`,
 * and the client registers a card under the same key.
 */
import z from '@deepseek-ai/schemastery';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
/** Settings namespace shared by the host half and the browser card. */
export const MEMORY_NS = 'dsh-sidebar-memory';
/** Default database file name inside the resolved memory directory. */
export const DEFAULT_DB_NAME = 'memory.sqlite';
/**
 * Field names the browser card may write. Kept next to the schema so a patch
 * from the page can be filtered without asking schemastery for reflection.
 */
export const MEMORY_CONFIG_KEYS = [
    'enabled',
    'mode',
    'localDir',
    'localDb',
    'embeddingEnabled',
    'embeddingBaseURL',
    'embeddingApiKey',
    'embeddingModel',
    'embeddingDim',
    'externalKind',
    'externalBaseURL',
    'externalApiKey',
    'externalNamespace',
    'externalSearchTool',
    'externalWriteTool',
    'autoExtract',
    'autoRecall',
    'recallTopK',
    'extractModel',
    'extractMode',
    'extractKeywords',
    'extractSource',
    'extractKinds',
    'extractFocus',
    'extractExclude',
    'extractMinConfidence',
    'extractMax',
    'fusion',
];
/**
 * Settings schema. Fields stay flat because the browser card renders them
 * directly and a flat shape needs no nested-form support from the host.
 */
export const Config = z.object({
    /** Master switch; when off no route, tool, recall, or extraction is active. */
    enabled: z.boolean().default(true),
    /** `local` keeps everything in SQLite, `external` proxies to a remote service. */
    mode: z.union([z.const('local'), z.const('external')]).default('local'),
    /** Directory holding the SQLite file; empty means `~/.dsh/dsh-sidebar/memory`. */
    localDir: z.string().default(''),
    /** SQLite file name inside `localDir`. */
    localDb: z.string().default(DEFAULT_DB_NAME),
    /** Whether vector recall runs at all. Requires an embedding endpoint below. */
    embeddingEnabled: z.boolean().default(false),
    /** OpenAI-compatible base URL, e.g. `https://api.openai.com/v1`. */
    embeddingBaseURL: z.string().default(''),
    /** Bearer token for the embedding endpoint. */
    embeddingApiKey: z.string().role('secret'),
    /** Embedding model id. */
    embeddingModel: z.string().default(''),
    /** Expected vector length; `0` means "accept whatever the endpoint returns". */
    embeddingDim: z.number().default(0),
    /** Remote protocol: Mem0-style HTTP REST, or MCP tools over HTTP. */
    externalKind: z.union([z.const('http'), z.const('mcp')]).default('http'),
    /** Remote base URL (REST root for `http`, MCP endpoint for `mcp`). */
    externalBaseURL: z.string().default(''),
    /** Remote bearer token, when the service needs one. */
    externalApiKey: z.string().role('secret'),
    /** Remote memory namespace / `user_id`. */
    externalNamespace: z.string().default('dsh'),
    /** MCP tool used for search in `mcp` mode; empty means auto-discovered. */
    externalSearchTool: z.string().default(''),
    /** MCP tool used for writes in `mcp` mode; empty means auto-discovered. */
    externalWriteTool: z.string().default(''),
    /** Extract durable facts with the session model once a turn settles. */
    autoExtract: z.boolean().default(true),
    /** Inject recalled memories into every model step. */
    autoRecall: z.boolean().default(true),
    /** How many memories one recall injects. */
    recallTopK: z.number().default(5),
    /** Extraction model override; empty means follow `agent-default-model`. */
    extractModel: z.string().default(''),
    /**
     * `auto` extracts every settled turn, `explicit` only when the user asks to
     * remember something.
     */
    extractMode: z.union([z.const('auto'), z.const('explicit')]).default('auto'),
    /** Trigger words for `explicit`; empty means the built-in list. */
    extractKeywords: z.string().default(''),
    /** `user` reads only what the user said, `both` also reads assistant text. */
    extractSource: z.union([z.const('user'), z.const('both')]).default('user'),
    /** Allowed kinds, comma separated; empty means every kind. */
    extractKinds: z.string().default(''),
    /** Extra "what to remember" requirement handed to the model. */
    extractFocus: z.string().default(''),
    /** "What never to remember" requirement handed to the model. */
    extractExclude: z.string().default(''),
    /** Facts below this confidence are dropped. */
    extractMinConfidence: z.number().step(0.05).min(0).max(1).default(0.7),
    /** Most facts taken from one turn. */
    extractMax: z.number().step(1).min(1).max(20).default(5),
    /** Ranking strategy across the fulltext / vector / like retrievers. */
    fusion: z.union([z.const('rrf'), z.const('vector'), z.const('fulltext')]).default('rrf'),
});
/** Every default, materialized so a missing section still yields a full value. */
export const DEFAULT_MEMORY_CONFIG = {
    enabled: true,
    mode: 'local',
    localDir: '',
    localDb: DEFAULT_DB_NAME,
    embeddingEnabled: false,
    embeddingBaseURL: '',
    embeddingApiKey: '',
    embeddingModel: '',
    embeddingDim: 0,
    externalKind: 'http',
    externalBaseURL: '',
    externalApiKey: '',
    externalNamespace: 'dsh',
    externalSearchTool: '',
    externalWriteTool: '',
    autoExtract: true,
    autoRecall: true,
    recallTopK: 5,
    extractModel: '',
    extractMode: 'auto',
    extractKeywords: '',
    extractSource: 'user',
    extractKinds: '',
    extractFocus: '',
    extractExclude: '',
    extractMinConfidence: 0.7,
    extractMax: 5,
    fusion: 'rrf',
};
/**
 * Build the current configuration by overlaying one settings section.
 * @param section - raw section value, already schema-resolved by the host.
 * @returns a fully populated configuration.
 */
export function resolveMemoryConfig(section) {
    const raw = (section ?? {});
    const pick = (key) => {
        const value = raw[key];
        return (value === undefined || value === null ? DEFAULT_MEMORY_CONFIG[key] : value);
    };
    const mode = pick('mode') === 'external' ? 'external' : 'local';
    const externalKind = pick('externalKind') === 'mcp' ? 'mcp' : 'http';
    const fusion = pick('fusion');
    return {
        enabled: pick('enabled') === true,
        mode,
        localDir: String(pick('localDir')),
        localDb: String(pick('localDb')) || DEFAULT_DB_NAME,
        embeddingEnabled: pick('embeddingEnabled') === true,
        embeddingBaseURL: String(pick('embeddingBaseURL')),
        embeddingApiKey: String(pick('embeddingApiKey')),
        embeddingModel: String(pick('embeddingModel')),
        embeddingDim: Number(pick('embeddingDim')) || 0,
        externalKind,
        externalBaseURL: String(pick('externalBaseURL')),
        externalApiKey: String(pick('externalApiKey')),
        externalNamespace: String(pick('externalNamespace')) || 'dsh',
        externalSearchTool: String(pick('externalSearchTool')),
        externalWriteTool: String(pick('externalWriteTool')),
        autoExtract: pick('autoExtract') === true,
        autoRecall: pick('autoRecall') === true,
        recallTopK: Math.min(50, Math.max(1, Math.trunc(Number(pick('recallTopK')) || 5))),
        extractModel: String(pick('extractModel')),
        extractMode: pick('extractMode') === 'explicit' ? 'explicit' : 'auto',
        extractKeywords: String(pick('extractKeywords')),
        extractSource: pick('extractSource') === 'both' ? 'both' : 'user',
        extractKinds: String(pick('extractKinds')),
        extractFocus: String(pick('extractFocus')),
        extractExclude: String(pick('extractExclude')),
        extractMinConfidence: clamp(Number(pick('extractMinConfidence')), 0, 1, DEFAULT_MEMORY_CONFIG.extractMinConfidence),
        extractMax: Math.min(20, Math.max(1, Math.trunc(Number(pick('extractMax')) || DEFAULT_MEMORY_CONFIG.extractMax))),
        fusion: fusion === 'vector' || fusion === 'fulltext' ? fusion : 'rrf',
    };
}
/**
 * Clamp one numeric setting.
 * @param value - raw value.
 * @param min - lower bound.
 * @param max - upper bound.
 * @param fallback - value used when the input is not finite.
 * @returns the clamped number.
 */
function clamp(value, min, max, fallback) {
    if (!Number.isFinite(value))
        return fallback;
    return Math.min(max, Math.max(min, value));
}
/**
 * Directory holding the SQLite file.
 * @param config - resolved configuration.
 * @returns absolute directory, defaulting to `<dsh home>/dsh-sidebar/memory`.
 */
export function resolveMemoryDir(config) {
    const configured = config.localDir.trim();
    return configured === '' ? dshHomePath('dsh-sidebar', 'memory') : configured;
}
/**
 * Absolute SQLite file path.
 * @param config - resolved configuration.
 * @returns the database path.
 */
export function resolveMemoryDb(config) {
    return `${resolveMemoryDir(config).replace(/[/\\]+$/, '')}/${config.localDb}`;
}
/**
 * Whether the configured backend could serve requests at all.
 * @param config - resolved configuration.
 * @returns a human-readable complaint, or `undefined` when usable.
 */
export function memoryConfigComplaint(config) {
    if (!config.enabled)
        return '记忆功能未启用';
    if (config.mode === 'external') {
        if (config.externalBaseURL.trim() === '')
            return '外部存储未填写服务地址';
        return undefined;
    }
    if (config.localDb.trim() === '')
        return '本地存储未填写数据库文件名';
    return undefined;
}
