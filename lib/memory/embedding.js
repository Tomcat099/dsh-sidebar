/**
 * Embedding client for the vector half of hybrid retrieval.
 *
 * The host ships no embedding model, so vectors come from an OpenAI-compatible
 * `/embeddings` endpoint. When the endpoint is unconfigured the plugin degrades
 * to fulltext retrieval instead of failing.
 */
import { createHash } from 'node:crypto';
/** How many query vectors are cached; recall repeats the same short strings. */
const CACHE_LIMIT = 256;
/** Per-request timeout for the embedding endpoint. */
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * Join a base URL with the embeddings path.
 * @param baseURL - configured base, with or without a trailing slash.
 * @returns the absolute endpoint.
 */
function embeddingsUrl(baseURL) {
    return `${baseURL.trim().replace(/[/]+$/, '')}/embeddings`;
}
/**
 * Read one vector out of a vendor response.
 * @param value - one `data[i]` entry, or a raw array.
 * @returns the vector, or `undefined` when the entry is not a number array.
 */
function readVector(value) {
    const candidate = Array.isArray(value)
        ? value
        : value?.embedding;
    if (!Array.isArray(candidate) || candidate.length === 0)
        return undefined;
    const vector = new Float32Array(candidate.length);
    for (let index = 0; index < candidate.length; index += 1) {
        const item = candidate[index];
        if (typeof item !== 'number' || !Number.isFinite(item))
            return undefined;
        vector[index] = item;
    }
    return vector;
}
/**
 * Pull the vector list out of an embeddings response body.
 * @param body - parsed JSON body.
 * @returns vectors in input order, empty when the shape is unrecognized.
 */
export function readEmbeddingsBody(body) {
    const record = body;
    const rows = Array.isArray(record?.data) ? record.data : Array.isArray(record?.embeddings) ? record.embeddings : [];
    const vectors = [];
    for (const row of rows) {
        const vector = readVector(row);
        if (vector === undefined)
            return [];
        vectors.push(vector);
    }
    return vectors;
}
/**
 * Create an embedder, or `undefined` when vectors are switched off or
 * under-configured.
 *
 * The configured dimension is sent as the OpenAI `dimensions` request field, so
 * the endpoint honours it; when a provider ignores it and answers with another
 * length, the response is adopted and reported instead of failing the caller.
 * @param settings - endpoint settings.
 * @param hooks - dimension observation callbacks.
 * @returns the embedder, or `undefined` to signal keyword-only retrieval.
 */
export function createEmbedder(settings, hooks = {}) {
    if (!settings.enabled)
        return undefined;
    if (settings.baseURL.trim() === '' || settings.model.trim() === '')
        return undefined;
    const url = embeddingsUrl(settings.baseURL);
    const model = settings.model.trim();
    const cache = new Map();
    let observedDim = settings.dim > 0 ? settings.dim : 0;
    const call = async (texts) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => { controller.abort(new Error('embedding request timed out')); }, REQUEST_TIMEOUT_MS);
        try {
            const headers = { 'content-type': 'application/json' };
            if (settings.apiKey.trim() !== '')
                headers.authorization = `Bearer ${settings.apiKey.trim()}`;
            const body = { model, input: texts };
            // OpenAI-compatible providers truncate the vector to this length.
            if (settings.dim > 0)
                body.dimensions = settings.dim;
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: controller.signal,
            });
            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                throw new Error(`嵌入接口返回 ${String(response.status)}${detail === '' ? '' : `：${detail.slice(0, 200)}`}`);
            }
            const vectors = readEmbeddingsBody(await response.json());
            if (vectors.length !== texts.length)
                throw new Error('嵌入接口返回的向量数量与输入不一致');
            const first = vectors[0];
            if (first !== undefined && first.length > 0) {
                if (first.length !== observedDim)
                    hooks.onDim?.(first.length, settings.dim);
                observedDim = first.length;
            }
            return vectors;
        }
        finally {
            clearTimeout(timeout);
        }
    };
    return {
        get dim() { return observedDim; },
        model,
        async embed(texts) {
            if (texts.length === 0)
                return [];
            const results = new Array(texts.length);
            const missing = [];
            texts.forEach((text, index) => {
                const cached = cache.get(createHash('sha256').update(text).digest('hex'));
                if (cached === undefined)
                    missing.push(index);
                else
                    results[index] = cached;
            });
            if (missing.length > 0) {
                const fetched = await call(missing.map((index) => texts[index] ?? ''));
                missing.forEach((index, offset) => {
                    const vector = fetched[offset];
                    if (vector === undefined)
                        return;
                    results[index] = vector;
                    const key = createHash('sha256').update(texts[index] ?? '').digest('hex');
                    if (cache.size >= CACHE_LIMIT)
                        cache.delete(cache.keys().next().value);
                    cache.set(key, vector);
                });
            }
            return results.map((vector, index) => vector ?? new Float32Array(observedDim > 0 ? observedDim : 0));
        },
    };
}
