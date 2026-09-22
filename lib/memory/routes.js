/**
 * HTTP surface for the settings card and the toolbox page.
 *
 * The browser never touches SQLite: it reads state, lists memories, and writes
 * through these routes, which own the provider and the settings namespace.
 */
/** Route prefix owned by the memory feature. */
export const MEMORY_ROUTE_PREFIX = '/api/dsh-sidebar/memory';
/** Routes registered by {@link registerMemoryRoutes}. */
const ROUTES = [
    { path: `${MEMORY_ROUTE_PREFIX}/state`, methods: ['GET'] },
    { path: `${MEMORY_ROUTE_PREFIX}/config`, methods: ['POST'] },
    { path: `${MEMORY_ROUTE_PREFIX}/list`, methods: ['GET'] },
    { path: `${MEMORY_ROUTE_PREFIX}/search`, methods: ['GET'] },
    { path: `${MEMORY_ROUTE_PREFIX}/write`, methods: ['POST'] },
    { path: `${MEMORY_ROUTE_PREFIX}/update`, methods: ['POST'] },
    { path: `${MEMORY_ROUTE_PREFIX}/remove`, methods: ['POST'] },
    { path: `${MEMORY_ROUTE_PREFIX}/dedupe`, methods: ['POST'] },
    { path: `${MEMORY_ROUTE_PREFIX}/reembed`, methods: ['POST'] },
];
/**
 * Read a non-negative integer query parameter.
 * @param params - URL search params.
 * @param key - parameter name.
 * @param fallback - value used when absent or unparsable.
 * @param max - upper clamp.
 * @returns the resolved integer.
 */
function intParam(params, key, fallback, max) {
    const raw = params.get(key);
    const parsed = raw === null ? Number.NaN : Number(raw);
    if (!Number.isFinite(parsed))
        return fallback;
    return Math.min(max, Math.max(0, Math.trunc(parsed)));
}
/**
 * Read one string field off a JSON body.
 * @param body - parsed body.
 * @param key - field name.
 * @returns the trimmed value, or `''`.
 */
function bodyString(body, key) {
    const value = body?.[key];
    return typeof value === 'string' ? value.trim() : '';
}
/**
 * Read one string-array field off a JSON body.
 * @param body - parsed body.
 * @param key - field name.
 * @returns the values, empty when the field is not an array.
 */
function bodyStrings(body, key) {
    const value = body?.[key];
    if (!Array.isArray(value))
        return [];
    return value.map((item) => String(item).trim()).filter((item) => item !== '');
}
/**
 * Map a thrown error onto a JSON response.
 * @param error - failure from a route.
 * @returns the response.
 */
function failure(error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 400 });
}
/**
 * Register the memory routes on the host connection.
 * @param ctx - context owning the routes.
 * @param api - runtime bindings.
 */
export function registerMemoryRoutes(ctx, api) {
    for (const route of ROUTES) {
        ctx.connection.fetch.register({
            path: route.path,
            methods: route.methods,
            requestBody: 'buffered',
            async fetch(request) {
                try {
                    request.signal.throwIfAborted();
                    const url = new URL(request.url);
                    switch (route.path) {
                        case `${MEMORY_ROUTE_PREFIX}/state`: {
                            return Response.json(await api.state());
                        }
                        case `${MEMORY_ROUTE_PREFIX}/config`: {
                            const body = await request.json();
                            await api.saveConfig((body ?? {}));
                            return Response.json(await api.state());
                        }
                        case `${MEMORY_ROUTE_PREFIX}/list`: {
                            const items = await api.list({
                                text: url.searchParams.get('q') ?? '',
                                limit: intParam(url.searchParams, 'limit', 50, 200),
                                offset: intParam(url.searchParams, 'offset', 0, 100_000),
                            });
                            return Response.json({ items });
                        }
                        case `${MEMORY_ROUTE_PREFIX}/search`: {
                            const query = url.searchParams.get('q') ?? '';
                            if (query.trim() === '')
                                return Response.json({ items: [] });
                            const items = await api.search({
                                text: query,
                                topK: intParam(url.searchParams, 'topK', 5, 50),
                            });
                            return Response.json({ items });
                        }
                        case `${MEMORY_ROUTE_PREFIX}/write`: {
                            const body = await request.json();
                            const content = bodyString(body, 'content');
                            if (content === '')
                                throw new Error('内容不能为空');
                            const written = await api.write({
                                kind: bodyString(body, 'kind') || 'fact',
                                content,
                                tags: bodyStrings(body, 'tags'),
                            });
                            return Response.json(written);
                        }
                        case `${MEMORY_ROUTE_PREFIX}/update`: {
                            const body = await request.json();
                            const id = bodyString(body, 'id');
                            if (id === '')
                                throw new Error('缺少记忆 id');
                            const draft = {};
                            if (typeof body.content === 'string')
                                draft.content = bodyString(body, 'content');
                            if (typeof body.kind === 'string')
                                draft.kind = bodyString(body, 'kind');
                            if (Array.isArray(body.tags))
                                draft.tags = bodyStrings(body, 'tags');
                            await api.update(id, draft);
                            return Response.json({ ok: true });
                        }
                        case `${MEMORY_ROUTE_PREFIX}/remove`: {
                            const body = await request.json();
                            const id = bodyString(body, 'id');
                            if (id === '')
                                throw new Error('缺少记忆 id');
                            await api.remove(id);
                            return Response.json({ ok: true });
                        }
                        case `${MEMORY_ROUTE_PREFIX}/dedupe`: {
                            return Response.json(await api.dedupe());
                        }
                        case `${MEMORY_ROUTE_PREFIX}/reembed`: {
                            return Response.json(await api.reembed());
                        }
                        default: {
                            return Response.json({ error: '未知的记忆接口' }, { status: 404 });
                        }
                    }
                }
                catch (error) {
                    return failure(error);
                }
            },
        });
    }
}
