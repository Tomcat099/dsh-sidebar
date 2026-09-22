/**
 * Moving plaintext credentials out of the settings file and into `~/.dsh/.env`.
 *
 * A literal token in `headers` or `env` is refused at save time, because it
 * would also land in every snapshot and every export. Refusing is only half a
 * feature though: the entries that already hold one are exactly the ones the
 * user cannot save until they are fixed, so this module produces a concrete
 * migration instead of a dead end.
 *
 * What can be moved automatically is bounded on purpose:
 *
 * - `Authorization: Bearer <token>` becomes `headerEnv.Authorization = VAR`
 *   with the token stored in `.env`. The mount renderer re-adds `Bearer `, so
 *   the round trip is exact.
 * - `env` literals become `envEnv` references, which have no prefixing.
 * - Anything else — a non-Bearer header, a token in a query string, one in a
 *   command argument — is reported with the reason rather than guessed at.
 *
 * The secret itself never leaves this module except into the `.env` file: the
 * plan carries variable names, counts, and lengths, never values.
 */
import { existsSync, readFileSync } from 'node:fs';
import { envFilePath, upsertEnvFile } from './env-file.js';
import { findSecretLiterals } from './schema.js';
/**
 * Derive a stable variable name for one credential.
 * @param id - server id.
 * @param key - header or environment variable name.
 * @returns an upper-case name built only from letters, digits, and underscores.
 */
export function deriveVariable(id, key) {
    const clean = (text) => text
        .toUpperCase()
        .replace(/[^A-Z0-9]+/gu, '_')
        .replace(/^_+|_+$/gu, '');
    const suffix = clean(key) === '' ? 'CREDENTIAL' : clean(key);
    return `MCP_${clean(id)}_${suffix}`.slice(0, 64);
}
/**
 * Read the variable names already present in an env file.
 * @param file - absolute path.
 * @returns the names found.
 */
function existingNames(file) {
    if (!existsSync(file))
        return new Set();
    const names = new Set();
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/u)) {
        const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
        if (match !== null)
            names.add(match[1]);
    }
    return names;
}
/**
 * Split an `Authorization: Bearer <token>` literal.
 * @param value - the stored header value.
 * @returns the bare token, or undefined when the value is not Bearer-shaped.
 */
function bearerToken(value) {
    const match = /^Bearer\s+(\S+)$/iu.exec(value.trim());
    return match === null ? undefined : match[1];
}
/**
 * Plan a migration for every entry that holds a plaintext credential.
 * @param servers - every configured entry, both scopes.
 * @param dshHome - absolute DSH home directory.
 * @returns the plan, including what cannot be moved and why.
 */
export function planCredentialMigration(servers, dshHome) {
    const file = envFilePath(dshHome);
    const existing = existingNames(file);
    const moves = [];
    const refusals = [];
    const seen = new Set();
    for (const server of servers) {
        for (const literal of findSecretLiterals(server)) {
            if (literal.field === 'args' || literal.field === 'url') {
                refusals.push({
                    id: server.id,
                    name: server.name ?? server.id,
                    field: literal.field,
                    key: literal.key,
                    reason: literal.field === 'args' ? '命令参数里的凭据没法自动搬，需要你自己改' : 'URL 查询参数里的凭据没法自动搬，需要你自己改',
                });
                continue;
            }
            const variable = deriveVariable(server.id, literal.key);
            if (seen.has(variable)) {
                refusals.push({
                    id: server.id,
                    name: server.name ?? server.id,
                    field: literal.field,
                    key: literal.key,
                    reason: `变量名 ${variable} 与另一处冲突，请手动处理`,
                });
                continue;
            }
            if (literal.field === 'headers') {
                const token = bearerToken(literal.value);
                if (token === undefined) {
                    refusals.push({
                        id: server.id,
                        name: server.name ?? server.id,
                        field: 'headers',
                        key: literal.key,
                        reason: `「${literal.key}」不是 Bearer 形式，自动搬家会把 Bearer 前缀丢掉；请手动改成环境变量引用`,
                    });
                    continue;
                }
                seen.add(variable);
                moves.push({
                    id: server.id,
                    name: server.name ?? server.id,
                    scope: server.scope,
                    field: 'headers',
                    key: literal.key,
                    variable,
                    length: token.length,
                    effect: existing.has(variable) ? 'replace' : 'add',
                });
                continue;
            }
            seen.add(variable);
            moves.push({
                id: server.id,
                name: server.name ?? server.id,
                scope: server.scope,
                field: 'env',
                key: literal.key,
                variable,
                length: literal.value.length,
                effect: existing.has(variable) ? 'replace' : 'add',
            });
        }
    }
    const ok = moves.length > 0;
    return {
        ok,
        message: ok
            ? `可以把 ${String(moves.length)} 处明文凭据搬到 ${file}${refusals.length === 0 ? '' : `，另有 ${String(refusals.length)} 处需要手动处理`}`
            : refusals.length === 0
                ? '没有发现明文凭据'
                : '没有可以自动搬移的凭据，都需要手动处理',
        file,
        moves,
        refusals,
    };
}
/**
 * Rewrite one entry so it references the environment instead of holding a value.
 * @param entry - entry to rewrite.
 * @param moves - credentials being moved out of this entry.
 * @returns the rewritten entry; the input is not modified.
 */
function rewriteEntry(entry, moves) {
    const next = { ...entry };
    const headers = { ...(entry.headers ?? {}) };
    const headerEnv = { ...(entry.headerEnv ?? {}) };
    const env = { ...(entry.env ?? {}) };
    const envEnv = { ...(entry.envEnv ?? {}) };
    for (const move of moves) {
        if (move.field === 'headers') {
            // The literal has to go, or it stays on disk and keeps blocking the save.
            delete headers[move.key];
            headerEnv[move.key] = move.variable;
            continue;
        }
        delete env[move.key];
        envEnv[move.key] = move.variable;
    }
    if (Object.keys(headers).length > 0)
        next.headers = headers;
    else
        delete next.headers;
    if (Object.keys(headerEnv).length > 0)
        next.headerEnv = headerEnv;
    if (Object.keys(env).length > 0)
        next.env = env;
    else
        delete next.env;
    if (Object.keys(envEnv).length > 0)
        next.envEnv = envEnv;
    return next;
}
/**
 * Apply a plan: write the env file, then hand back the rewritten entries.
 *
 * The `.env` is written first. If it is refused (a reserved name, an
 * unwritable value) nothing is rewritten, so the configuration is never left
 * pointing at a variable that does not exist.
 * @param servers - every configured entry, both scopes.
 * @param plan - plan from {@link planCredentialMigration}.
 * @returns the outcome, plus the rewritten entries grouped by scope.
 */
export function applyCredentialMigration(servers, plan) {
    if (plan.moves.length === 0) {
        return { outcome: { ok: false, message: '这个方案里没有可搬移的凭据', added: [], replaced: [], rewrote: [] } };
    }
    const writes = [];
    for (const move of plan.moves) {
        const source = servers.find(server => server.id === move.id && server.scope === move.scope);
        if (source === undefined)
            continue;
        const literal = findSecretLiterals(source).find(item => item.field === move.field && item.key === move.key);
        if (literal === undefined)
            continue;
        const value = move.field === 'headers' ? bearerToken(literal.value) : literal.value;
        if (value === undefined)
            continue;
        writes.push({ name: move.variable, value });
    }
    const written = upsertEnvFile(plan.file, writes);
    if (written.refused.length > 0) {
        return {
            outcome: {
                ok: false,
                message: written.refused.map(item => `${item.name}：${item.reason}`).join('；'),
                added: [],
                replaced: [],
                rewrote: [],
            },
        };
    }
    const globals = [];
    const projects = [];
    const rewrote = [];
    for (const server of servers) {
        const own = plan.moves.filter(move => move.id === server.id && move.scope === server.scope);
        const next = own.length === 0 ? { ...server } : rewriteEntry(server, own);
        if (own.length > 0)
            rewrote.push(`${server.scope}:${server.id}`);
        const { scope, ...entry } = next;
        if (scope === 'project')
            projects.push(entry);
        else
            globals.push(entry);
    }
    return {
        outcome: {
            ok: true,
            message: `已把 ${String(plan.moves.length)} 处凭据搬进 ${plan.file}；DSH 只在启动时读这个文件，重启 dsh web 后生效`,
            added: written.added,
            replaced: written.replaced,
            rewrote,
        },
        servers: { global: globals, project: projects },
    };
}
