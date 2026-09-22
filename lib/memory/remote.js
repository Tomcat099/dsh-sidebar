/**
 * Remote memory backends: Mem0-style HTTP REST, and MCP tools over HTTP.
 *
 * Both speak JSON over `fetch`, so the plugin needs no client dependency. The
 * REST contract follows Mem0's `/memories` endpoints; the MCP contract follows
 * the streamable-HTTP JSON-RPC transport.
 */
/** Per-request timeout for a remote memory call. */
const REMOTE_TIMEOUT_MS = 20_000;
/**
 * Strip trailing slashes so path joins stay predictable.
 * @param value - configured base URL.
 * @returns the normalized base.
 */
function trimBase(value) {
    return value.trim().replace(/[/]+$/, '');
}
/**
 * Issue a JSON request with a deadline.
 * @param url - absolute URL.
 * @param init - request init; the body is serialized when present.
 * @param timeoutMs - deadline in milliseconds.
 * @returns the parsed body and the raw response.
 */
async function requestJson(url, init, timeoutMs = REMOTE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => { controller.abort(new Error('远程记忆服务响应超时')); }, timeoutMs);
    try {
        const headers = { accept: init.accept ?? 'application/json' };
        if (init.body !== undefined)
            headers['content-type'] = 'application/json';
        if (init.apiKey !== undefined && init.apiKey.trim() !== '')
            headers.authorization = `Bearer ${init.apiKey.trim()}`;
        const response = await fetch(url, {
            method: init.method,
            headers,
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
            signal: controller.signal,
        });
        const text = await response.text();
        return { response, body: parseMaybeJson(text) };
    }
    finally {
        clearTimeout(timeout);
    }
}
/**
 * Parse a body that may be JSON, SSE, or plain text.
 * @param text - raw response text.
 * @returns the parsed value, or the raw text when nothing parses.
 */
function parseMaybeJson(text) {
    const trimmed = text.trim();
    if (trimmed === '')
        return undefined;
    try {
        return JSON.parse(trimmed);
    }
    catch {
        // Streamable HTTP transports may answer with an SSE event stream.
    }
    const dataLines = trimmed.split('\n').filter((line) => line.startsWith('data:'));
    for (const line of dataLines.reverse()) {
        try {
            return JSON.parse(line.slice('data:'.length).trim());
        }
        catch {
            // Try the next event; only the last well-formed payload matters.
        }
    }
    return trimmed;
}
/**
 * Read a string field.
 * @param value - candidate value.
 * @returns the string, or `undefined` when it is not a non-empty string.
 */
function readString(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
/**
 * Read an epoch-millisecond timestamp from seconds, milliseconds, or ISO text.
 * @param value - candidate value.
 * @param fallback - value used when nothing parses.
 * @returns epoch milliseconds.
 */
function readTime(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
    if (typeof value === 'string') {
        const parsed = Date.parse(value);
        if (Number.isFinite(parsed))
            return parsed;
        const numeric = Number(value);
        if (Number.isFinite(numeric))
            return numeric < 1e12 ? Math.trunc(numeric * 1000) : Math.trunc(numeric);
    }
    return fallback;
}
/**
 * Normalize one remote row.
 * @param row - remote record.
 * @returns the memory hit, or `undefined` when the row carries no text.
 */
function toHit(row) {
    const record = row;
    if (record === undefined || record === null)
        return undefined;
    const content = readString(record.memory) ?? readString(record.text) ?? readString(record.content);
    if (content === undefined)
        return undefined;
    const metadata = (record.metadata ?? {});
    const tagsValue = metadata.tags ?? record.tags;
    const tags = Array.isArray(tagsValue)
        ? tagsValue.map((tag) => String(tag)).filter((tag) => tag.trim() !== '')
        : typeof tagsValue === 'string' ? tagsValue.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '') : [];
    const now = Date.now();
    return {
        id: readString(record.id) ?? readString(record.memory_id) ?? content,
        kind: readString(metadata.kind) ?? readString(record.kind) ?? 'fact',
        content,
        tags,
        ...(readString(metadata.source_session) === undefined ? {} : { sourceSession: readString(metadata.source_session) }),
        ...(readString(metadata.source_workspace) === undefined ? {} : { sourceWorkspace: readString(metadata.source_workspace) }),
        confidence: Number(metadata.confidence ?? record.confidence ?? 1) || 1,
        createdAt: readTime(record.created_at ?? record.createdAt, now),
        updatedAt: readTime(record.updated_at ?? record.updatedAt, now),
        score: Number(record.score ?? 0) || 0,
        sources: ['remote'],
    };
}
/**
 * Pull a row array out of a vendor response.
 * @param body - parsed response body.
 * @returns rows in vendor order.
 */
function readRows(body) {
    if (Array.isArray(body))
        return body;
    const record = body;
    for (const candidate of [record?.results, record?.memories, record?.data]) {
        if (Array.isArray(candidate))
            return candidate;
    }
    return [];
}
/**
 * Pull a created id out of a vendor response.
 * @param body - parsed response body.
 * @param fallback - id used when the vendor reports none.
 * @returns the id.
 */
function readCreatedId(body, fallback) {
    const record = body;
    const direct = readString(record?.id) ?? readString(record?.memory_id);
    if (direct !== undefined)
        return direct;
    const rows = readRows(body);
    const first = rows[0];
    return readString(first?.id) ?? fallback;
}
/** Mem0-style HTTP REST backend. */
export class HttpMemoryProvider {
    kind = 'http';
    base;
    settings;
    /**
     * @param settings - endpoint settings.
     */
    constructor(settings) {
        this.settings = settings;
        this.base = trimBase(settings.baseURL);
    }
    /** {@inheritDoc MemoryProvider.health} */
    async health() {
        try {
            const { response } = await requestJson(`${this.base}/memories?user_id=${encodeURIComponent(this.settings.namespace)}&limit=1`, { method: 'GET', apiKey: this.settings.apiKey }, 8000);
            return response.ok
                ? { ok: true, kind: 'http', detail: `外部 REST 服务可用（${this.base}）` }
                : { ok: false, kind: 'http', detail: `外部 REST 服务返回 ${String(response.status)}` };
        }
        catch (error) {
            return { ok: false, kind: 'http', detail: error instanceof Error ? error.message : String(error) };
        }
    }
    /** {@inheritDoc MemoryProvider.count} */
    async count() {
        const rows = await this.list({ limit: 200, offset: 0 });
        return rows.length;
    }
    /** {@inheritDoc MemoryProvider.write} */
    async write(draft) {
        const { response, body } = await requestJson(`${this.base}/memories`, {
            method: 'POST',
            apiKey: this.settings.apiKey,
            body: {
                messages: [{ role: 'user', content: draft.content }],
                user_id: this.settings.namespace,
                metadata: {
                    kind: draft.kind,
                    tags: draft.tags ?? [],
                    confidence: draft.confidence ?? 1,
                    ...(draft.sourceSession === undefined ? {} : { source_session: draft.sourceSession }),
                    ...(draft.sourceWorkspace === undefined ? {} : { source_workspace: draft.sourceWorkspace }),
                },
            },
        });
        if (!response.ok)
            throw new Error(`外部记忆写入失败：HTTP ${String(response.status)}`);
        return { id: readCreatedId(body, draft.content), created: true };
    }
    /** {@inheritDoc MemoryProvider.search} */
    async search(query) {
        const { response, body } = await requestJson(`${this.base}/memories/search`, {
            method: 'POST',
            apiKey: this.settings.apiKey,
            body: { query: query.text, user_id: this.settings.namespace, limit: query.topK },
        });
        if (!response.ok)
            throw new Error(`外部记忆检索失败：HTTP ${String(response.status)}`);
        return readRows(body).flatMap((row) => {
            const hit = toHit(row);
            return hit === undefined ? [] : [hit];
        });
    }
    /** {@inheritDoc MemoryProvider.list} */
    async list(options) {
        const url = `${this.base}/memories?user_id=${encodeURIComponent(this.settings.namespace)}&limit=${String(options.limit)}&offset=${String(options.offset)}`;
        const { response, body } = await requestJson(url, { method: 'GET', apiKey: this.settings.apiKey });
        if (!response.ok)
            throw new Error(`外部记忆列表失败：HTTP ${String(response.status)}`);
        const text = (options.text ?? '').trim().toLowerCase();
        return readRows(body).flatMap((row) => {
            const hit = toHit(row);
            if (hit === undefined)
                return [];
            if (text !== '' && !hit.content.toLowerCase().includes(text) && !hit.tags.some((tag) => tag.toLowerCase().includes(text)))
                return [];
            return [hit];
        });
    }
    /** {@inheritDoc MemoryProvider.update} */
    async update(id, patch) {
        const { response } = await requestJson(`${this.base}/memories/${encodeURIComponent(id)}`, {
            method: 'PUT',
            apiKey: this.settings.apiKey,
            body: {
                ...(patch.content === undefined ? {} : { text: patch.content }),
                metadata: {
                    ...(patch.kind === undefined ? {} : { kind: patch.kind }),
                    ...(patch.tags === undefined ? {} : { tags: patch.tags }),
                    ...(patch.confidence === undefined ? {} : { confidence: patch.confidence }),
                },
            },
        });
        if (!response.ok)
            throw new Error(`外部记忆更新失败：HTTP ${String(response.status)}`);
    }
    /** {@inheritDoc MemoryProvider.remove} */
    async remove(id) {
        const { response } = await requestJson(`${this.base}/memories/${encodeURIComponent(id)}`, {
            method: 'DELETE',
            apiKey: this.settings.apiKey,
        });
        if (!response.ok)
            throw new Error(`外部记忆删除失败：HTTP ${String(response.status)}`);
    }
}
/** MCP tools over streamable HTTP. */
export class McpMemoryProvider {
    kind = 'mcp';
    settings;
    sequence = 0;
    tools;
    /**
     * @param settings - endpoint settings.
     */
    constructor(settings) {
        this.settings = settings;
    }
    /**
     * Resolve which tools to use.
     *
     * Explicitly configured names win; otherwise the tool list is fetched once
     * and search/write tools are picked by their usual naming, so a mounted
     * memory server works without any tool-name configuration.
     * @returns the resolved tool names.
     */
    async resolveTools() {
        if (this.tools !== undefined)
            return this.tools;
        const configuredSearch = this.settings.searchTool.trim();
        const configuredWrite = this.settings.writeTool.trim();
        if (configuredSearch !== '' && configuredWrite !== '') {
            this.tools = { search: configuredSearch, write: configuredWrite };
            return this.tools;
        }
        const result = await this.call('tools/list', {});
        const tools = result?.tools;
        const names = Array.isArray(tools)
            ? tools.flatMap((tool) => {
                const name = readString(tool.name);
                return name === undefined ? [] : [name];
            })
            : [];
        if (names.length === 0)
            throw new Error('MCP 服务没有提供任何工具，无法自动选择记忆工具');
        const pick = (patterns, exclude) => {
            for (const pattern of patterns) {
                const found = names.find((name) => pattern.test(name) && name !== exclude);
                if (found !== undefined)
                    return found;
            }
            return undefined;
        };
        const search = configuredSearch !== ''
            ? configuredSearch
            : pick([/search|query|find|recall|retrieve/i], undefined) ?? names[0];
        const write = configuredWrite !== ''
            ? configuredWrite
            : pick([/add|write|create|store|save|remember|insert/i], search) ?? (names.find((name) => name !== search) ?? search);
        this.tools = { search, write };
        return this.tools;
    }
    /** {@inheritDoc MemoryProvider.health} */
    async health() {
        try {
            const tools = await this.resolveTools();
            return {
                ok: true,
                kind: 'mcp',
                detail: `MCP 记忆服务可用（检索 ${tools.search} · 写入 ${tools.write}）`,
            };
        }
        catch (error) {
            return { ok: false, kind: 'mcp', detail: error instanceof Error ? error.message : String(error) };
        }
    }
    /** {@inheritDoc MemoryProvider.count} */
    async count() {
        return (await this.list({ limit: 200, offset: 0 })).length;
    }
    /** {@inheritDoc MemoryProvider.write} */
    async write(draft) {
        const tools = await this.resolveTools();
        const result = await this.call(tools.write, {
            content: draft.content,
            kind: draft.kind,
            tags: draft.tags ?? [],
            user_id: this.settings.namespace,
            ...(draft.sourceSession === undefined ? {} : { source_session: draft.sourceSession }),
            ...(draft.sourceWorkspace === undefined ? {} : { source_workspace: draft.sourceWorkspace }),
            confidence: draft.confidence ?? 1,
        });
        return { id: readCreatedId(readToolPayload(result), draft.content), created: true };
    }
    /** {@inheritDoc MemoryProvider.search} */
    async search(query) {
        const tools = await this.resolveTools();
        const result = await this.call(tools.search, {
            query: query.text,
            limit: query.topK,
            user_id: this.settings.namespace,
        });
        return readRows(readToolPayload(result)).flatMap((row) => {
            const hit = toHit(row);
            return hit === undefined ? [] : [{ ...hit, sources: ['mcp'] }];
        });
    }
    /** {@inheritDoc MemoryProvider.list} */
    async list(options) {
        const tools = await this.resolveTools();
        const result = await this.call(tools.search, {
            query: options.text ?? '',
            limit: options.limit,
            offset: options.offset,
            user_id: this.settings.namespace,
        });
        return readRows(readToolPayload(result)).flatMap((row) => {
            const hit = toHit(row);
            return hit === undefined ? [] : [{ ...hit, sources: ['mcp'] }];
        });
    }
    /** {@inheritDoc MemoryProvider.update} */
    async update() {
        throw new Error('MCP 记忆服务暂不支持在线编辑，请在外部服务里维护');
    }
    /** {@inheritDoc MemoryProvider.remove} */
    async remove() {
        throw new Error('MCP 记忆服务暂不支持在线删除，请在外部服务里维护');
    }
    /**
     * Invoke one MCP tool.
     * @param name - tool name.
     * @param args - tool arguments.
     * @returns the raw `result` payload.
     */
    async call(name, args) {
        this.sequence += 1;
        const { response, body } = await requestJson(trimBase(this.settings.baseURL), {
            method: 'POST',
            apiKey: this.settings.apiKey,
            accept: 'application/json, text/event-stream',
            body: { jsonrpc: '2.0', id: this.sequence, method: 'tools/call', params: { name, arguments: args } },
        });
        if (!response.ok)
            throw new Error(`MCP 调用失败：HTTP ${String(response.status)}`);
        const record = body;
        if (record?.error !== undefined)
            throw new Error(`MCP 返回错误：${String(record.error.message ?? '未知错误')}`);
        return record?.result;
    }
}
/**
 * Decode an MCP tool result into its structured payload.
 * @param result - raw MCP `result` value.
 * @returns the parsed payload, the first text block, or the raw value.
 */
function readToolPayload(result) {
    const content = result?.content;
    if (Array.isArray(content)) {
        for (const block of content) {
            const text = readString(block.text);
            if (text === undefined)
                continue;
            return parseMaybeJson(text);
        }
    }
    return result;
}
