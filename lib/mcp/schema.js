/**
 * MCP server configuration model shared by the settings UI and the Host routes.
 *
 * One entry describes one `@deepseek-ai/dsh-mcp-client` instance. The shape
 * mirrors that plugin's `Config` without importing it, so this package stays
 * installable beside any DSH version.
 *
 * Documents are scope-local: the profile directory holds the `global` list and
 * a project root holds its own `project` list. Nothing here knows which file it
 * came from — the store does.
 */
import { checkUrl, isRiskConfirmable } from './url-policy.js';
/** Empty settings document. */
export const EMPTY_DOCUMENT = { revision: 0, servers: [] };
/** Server id accepted as a tool namespace; mirrors `mcp-client`'s own rule. */
const SERVER_ID = /^[A-Za-z0-9_-]{1,32}$/u;
/** Valid JavaScript environment variable name (used in `process.env.<name>`). */
const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
/** HTTP header name accepted by `fetch`. */
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/u;
/** Longest display name kept, matching the connector-rename limit elsewhere. */
const MAX_NAME_LENGTH = 80;
/**
 * Literal values that are certainly credentials: a scheme prefix, a JWT, or a
 * vendor key prefix. These are flagged wherever they appear.
 */
const SECRET_SHAPED = [
    /^Bearer\s+\S+/iu,
    /^ey[A-Za-z0-9_-]{10,}\./u,
    /^(?:sk|pk|ghp|gho|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{10,}$/u,
    /^AKIA[0-9A-Z]{16}$/u,
];
/**
 * Literal values that merely *look* like random data — a long hex or base64
 * run. A commit sha or a content hash has the same shape, so these only count
 * as credentials next to something that names one.
 */
const AMBIGUOUS_SECRET_SHAPED = [
    /^[0-9a-f]{32,}$/iu,
    /^[A-Za-z0-9+/]{40,}={0,2}$/u,
];
/** Argument flags whose following value is usually a credential. */
const SECRET_FLAGS = /(?:^|[-_])(?:token|key|secret|password|passwd|apikey|auth)(?:$|[=:])/iu;
/** Query parameter names that usually carry a credential. */
const SECRET_PARAMS = /^(?:access_?token|api_?key|apikey|token|key|secret|password|sig|signature)$/iu;
/**
 * Normalize a transport value coming from any source.
 * `sse` collapses into `streamable-http` because the MCP client's
 * streamable-http transport still speaks the older SSE endpoints.
 * @param raw - value from a file, a form, or an imported JSON document.
 * @returns the supported transport, or undefined when unrecognizable.
 */
export function normalizeTransport(raw) {
    if (typeof raw !== 'string')
        return undefined;
    const text = raw.trim().toLowerCase();
    if (text === 'stdio')
        return 'stdio';
    if (text === 'streamable-http' || text === 'streamable_http' || text === 'http' || text === 'sse') {
        return 'streamable-http';
    }
    return undefined;
}
/**
 * Pick the effective display name for an entry.
 * @param entry - configured server.
 * @returns the display name, never empty.
 */
export function displayName(entry) {
    const trimmed = (entry.name ?? '').trim();
    return trimmed === '' ? entry.id : trimmed;
}
/**
 * Describe an entry's endpoint in one line, for lists and diagnostics.
 * @param entry - configured server.
 * @returns a human-readable summary of where it connects.
 */
export function endpointLabel(entry) {
    if (entry.transport === 'stdio') {
        return [entry.command ?? '', ...(entry.args ?? [])].filter(part => part !== '').join(' ').trim();
    }
    const raw = (entry.url ?? '').trim();
    if (raw === '')
        return '';
    try {
        const parsed = new URL(raw);
        const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/u, '');
        return `${parsed.host}${path}`;
    }
    catch {
        return raw;
    }
}
/**
 * Validate one environment-variable reference (a `headerEnv` / `envEnv` value).
 * @param id - owning server id, for error messages.
 * @param label - field label shown to the user.
 * @param variable - candidate variable name.
 * @returns issues found, empty when the reference is usable.
 */
function checkEnvReference(id, label, variable, field) {
    const trimmed = variable.trim();
    if (trimmed === '')
        return [];
    if (!ENV_VAR_NAME.test(trimmed)) {
        return [{
                code: 'env-ref-invalid',
                id,
                field,
                message: `「${id}」的 ${label} 环境变量名「${trimmed}」不合法：` +
                    `须以字母或下划线开头，只能含字母、数字、下划线。` +
                    `此处应填变量名（如 MCP_AUTH_TOKEN），不是 token 本身；` +
                    `token 写入 ~/.dsh/.env`,
            }];
    }
    if (SECRET_SHAPED.some(pattern => pattern.test(trimmed))) {
        return [{
                code: 'env-ref-token',
                id,
                field,
                message: `「${id}」的 ${label} 看起来是 token 本身；` +
                    `请改为变量名（如 MCP_AUTH_TOKEN），并把 token 写入 ~/.dsh/.env`,
            }];
    }
    return [];
}
/**
 * Find literal strings in one entry that look like credentials.
 *
 * The point is not to be exhaustive — it is to stop a pasted token from being
 * written into a file that the export, snapshot, and log paths all read.
 * @param entry - configured server.
 * @returns every suspicious literal, in a stable order.
 */
export function findSecretLiterals(entry) {
    const found = [];
    for (const [header, value] of Object.entries(entry.headers ?? {})) {
        if (SECRET_SHAPED.some(pattern => pattern.test(value.trim()))) {
            found.push({ field: 'headers', key: header, value });
        }
    }
    for (const [name, value] of Object.entries(entry.env ?? {})) {
        if (SECRET_SHAPED.some(pattern => pattern.test(value.trim()))) {
            found.push({ field: 'env', key: name, value });
        }
    }
    const args = entry.args ?? [];
    for (const [index, arg] of args.entries()) {
        const text = arg.trim();
        if (SECRET_SHAPED.some(pattern => pattern.test(text))) {
            found.push({ field: 'args', key: String(index), value: arg });
            continue;
        }
        // A hash-shaped value is only suspicious when the flag before it names a
        // credential; otherwise it is just as likely to be a commit id.
        if (!AMBIGUOUS_SECRET_SHAPED.some(pattern => pattern.test(text)))
            continue;
        const previous = (args[index - 1] ?? '').trim();
        if (SECRET_FLAGS.test(previous) || SECRET_FLAGS.test(text)) {
            found.push({ field: 'args', key: String(index), value: arg });
        }
    }
    if (entry.url !== undefined && entry.url.trim() !== '') {
        try {
            const parsed = new URL(entry.url.trim());
            for (const key of parsed.searchParams.keys()) {
                if (SECRET_PARAMS.test(key)) {
                    found.push({ field: 'url', key, value: parsed.searchParams.get(key) ?? '' });
                    break;
                }
            }
        }
        catch {
            // A malformed URL is reported by the shape checks, not here.
        }
    }
    return found;
}
/**
 * Validate the `env` / `headers` / `envEnv` / `headerEnv` maps of one entry.
 * @param entry - configured server.
 * @returns issues found, empty when every map is usable.
 */
function checkMaps(entry) {
    const issues = [];
    for (const [name, value] of Object.entries(entry.headers ?? {})) {
        if (!HEADER_NAME.test(name)) {
            issues.push({ code: 'header-name', id: entry.id, field: 'headers', message: `「${entry.id}」的 Header 名「${name}」不合法` });
        }
        if (/[\r\n]/u.test(value)) {
            issues.push({ code: 'header-value', id: entry.id, field: 'headers', message: `「${entry.id}」的 Header「${name}」不能包含换行` });
        }
    }
    for (const [name, value] of Object.entries(entry.env ?? {})) {
        if (!ENV_VAR_NAME.test(name)) {
            issues.push({ code: 'env-name', id: entry.id, field: 'env', message: `「${entry.id}」的环境变量名「${name}」不合法` });
        }
        if (/[\r\n]/u.test(value)) {
            issues.push({ code: 'env-value', id: entry.id, field: 'env', message: `「${entry.id}」的环境变量「${name}」不能包含换行` });
        }
    }
    for (const [header, variable] of Object.entries(entry.headerEnv ?? {})) {
        if (!HEADER_NAME.test(header)) {
            issues.push({ code: 'header-name', id: entry.id, field: 'headerEnv', message: `「${entry.id}」的 Header 名「${header}」不合法` });
        }
        issues.push(...checkEnvReference(entry.id, header, variable, 'headerEnv'));
    }
    for (const [name, variable] of Object.entries(entry.envEnv ?? {})) {
        if (!ENV_VAR_NAME.test(name)) {
            issues.push({ code: 'env-name', id: entry.id, field: 'envEnv', message: `「${entry.id}」的环境变量名「${name}」不合法` });
        }
        issues.push(...checkEnvReference(entry.id, name, variable, 'envEnv'));
    }
    return issues;
}
/**
 * Validate one entry at the settings boundary.
 *
 * Shape and policy are checked together so a save cannot land a URL the runtime
 * would later refuse to fetch. Secret-shaped literals are reported as issues
 * rather than errors — they are a hygiene problem, not a broken connection.
 * @param entry - candidate entry from the browser or a settings file.
 * @returns issues found, empty when the entry is usable.
 */
export function validateEntry(entry) {
    const issues = [];
    if (!SERVER_ID.test(entry.id)) {
        issues.push({
            code: 'id-format',
            id: entry.id,
            field: 'id',
            message: `ID「${entry.id}」不合法：只能用字母、数字、下划线、连字符，长度 1-32`,
        });
        return issues;
    }
    if ((entry.name ?? '').trim().length > MAX_NAME_LENGTH) {
        issues.push({
            code: 'name-length',
            id: entry.id,
            field: 'name',
            message: `「${entry.id}」的显示名最长 ${String(MAX_NAME_LENGTH)} 个字符`,
        });
    }
    if (entry.transport === 'stdio') {
        if ((entry.command ?? '').trim() === '') {
            issues.push({ code: 'command-missing', id: entry.id, field: 'command', message: `「${entry.id}」缺少 command` });
        }
    }
    else if (entry.transport === 'streamable-http') {
        const raw = (entry.url ?? '').trim();
        if (raw === '') {
            issues.push({ code: 'url-missing', id: entry.id, field: 'url', message: `「${entry.id}」缺少 url` });
        }
        else {
            const verdict = checkUrl(raw, { allowInsecurePrivateNetwork: entry.insecurePrivateNetwork === true });
            if (!verdict.ok) {
                issues.push({
                    code: `url-${verdict.code ?? 'malformed'}`,
                    id: entry.id,
                    field: 'url',
                    message: `「${entry.id}」：${verdict.message ?? 'URL 不被接受'}`,
                    confirmable: isRiskConfirmable(verdict.code),
                });
            }
        }
    }
    else {
        issues.push({ code: 'transport-invalid', id: entry.id, field: 'transport', message: `「${entry.id}」的 transport 必须是 stdio 或 streamable-http` });
    }
    issues.push(...checkMaps(entry));
    return issues;
}
/**
 * Validate a whole document, including id uniqueness.
 * @param doc - candidate document.
 * @returns the verdict plus every problem found.
 */
export function validateDocument(doc) {
    const issues = [];
    const seen = new Set();
    for (const entry of doc.servers) {
        issues.push(...validateEntry(entry));
        if (seen.has(entry.id)) {
            issues.push({ code: 'id-duplicate', id: entry.id, field: 'id', message: `ID「${entry.id}」重复` });
        }
        seen.add(entry.id);
    }
    const blocking = issues;
    return { ok: blocking.length === 0, issues };
}
/**
 * Read one string map, dropping non-string values.
 * @param value - raw candidate.
 * @returns a clean map, or undefined when nothing usable was found.
 */
function stringMap(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const out = {};
    for (const [key, raw] of Object.entries(value)) {
        if (typeof raw === 'string' && raw !== '')
            out[key] = raw;
    }
    return Object.keys(out).length === 0 ? undefined : out;
}
/**
 * Coerce one parsed value into an entry, filling defaults where the shape allows.
 * @param value - candidate from a file, a form, or an import.
 * @returns the entry, or undefined when a required field is missing.
 */
export function normalizeEntry(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const raw = value;
    const id = typeof raw.id === 'string' ? raw.id.trim() : '';
    const transport = normalizeTransport(raw.transport ?? raw.type);
    if (id === '' || transport === undefined)
        return undefined;
    const entry = {
        id,
        enabled: raw.enabled !== false,
        transport,
    };
    if (typeof raw.name === 'string' && raw.name.trim() !== '')
        entry.name = raw.name.trim();
    if (typeof raw.command === 'string' && raw.command.trim() !== '')
        entry.command = raw.command.trim();
    if (Array.isArray(raw.args)) {
        const args = raw.args.filter((item) => typeof item === 'string');
        if (args.length > 0)
            entry.args = args;
    }
    if (typeof raw.cwd === 'string' && raw.cwd.trim() !== '')
        entry.cwd = raw.cwd.trim();
    if (typeof raw.url === 'string' && raw.url.trim() !== '')
        entry.url = raw.url.trim();
    if (typeof raw.toolsets === 'string' && raw.toolsets.trim() !== '')
        entry.toolsets = raw.toolsets.trim();
    if (raw.readonly === true)
        entry.readonly = true;
    if (raw.insecurePrivateNetwork === true)
        entry.insecurePrivateNetwork = true;
    const env = stringMap(raw.env);
    if (env !== undefined)
        entry.env = env;
    const envEnv = stringMap(raw.envEnv);
    if (envEnv !== undefined)
        entry.envEnv = envEnv;
    const headers = stringMap(raw.headers);
    if (headers !== undefined)
        entry.headers = headers;
    const headerEnv = stringMap(raw.headerEnv);
    if (headerEnv !== undefined)
        entry.headerEnv = headerEnv;
    return entry;
}
/**
 * Narrow one parsed value to a scope document, tolerating the legacy shape.
 * @param value - parsed JSON from a settings file.
 * @returns the document, or undefined when the value is not a usable document.
 */
export function decodeDocument(value) {
    if (typeof value !== 'object' || value === null)
        return undefined;
    const raw = value;
    if (!Array.isArray(raw.servers))
        return undefined;
    const servers = [];
    for (const item of raw.servers) {
        const entry = normalizeEntry(item);
        if (entry !== undefined)
            servers.push(entry);
    }
    const revision = typeof raw.revision === 'number' && Number.isFinite(raw.revision) ? raw.revision : 0;
    return { revision, servers };
}
