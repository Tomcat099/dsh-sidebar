/**
 * Host half of dsh-sidebar.
 *
 * 「新对话」reuses one background workspace. The browser hides that workspace
 * and lists its sessions under 「最近对话」.
 */
import { mkdir } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { dshHomePath } from '@deepseek-ai/dsh-home-paths';
import { applyMcp } from './mcp/host.js';
import { applyMemory } from './memory/index.js';
import { isJustChatPath } from './nav.js';
import { SkillError, findProjectRoot, installFromUpload, installSkill, listInstallCandidates, scanSkills, skillRoots, toggleSkill, } from './skills.js';
/** Cordis plugin name. */
export const name = 'dsh-sidebar';
/** Route the sidebar calls before opening a chat in the background project. */
export const PREPARE_ROUTE = '/api/dsh-sidebar/recent';
/** Stable title of the hidden background project. */
const RECENT_TITLE = '最近对话';
/**
 * Ensure the single background directory exists and is registered, and install
 * the memory feature.
 * @param ctx - host context.
 * @param config - composition config; the memory settings section overlays it.
 */
export function apply(ctx, config) {
    applyMcp(ctx);
    applyMemory(ctx, config);
    ctx.inject(['connection', 'workspaceRegistry'], (pluginCtx) => {
        registerRecent(pluginCtx);
        registerSkills(pluginCtx);
    });
}
/**
 * Read the live skill-filesystem config. Missing fibers fall back to the
 * same defaults the host uses.
 * @param ctx - host context.
 * @returns custom directories and the bundled root, if one is configured.
 */
function filesystemConfig(ctx) {
    const custom = new Set();
    let bundled = process.env.DSH_BUNDLED_SKILL_DIR;
    let includeDefaults = true;
    let explicitBundled = false;
    for (const runtime of ctx.registry.values()) {
        if (runtime.name !== 'skill-filesystem' && runtime.name !== '@deepseek-ai/dsh-skill-filesystem')
            continue;
        for (const fiber of runtime.fibers) {
            if (typeof fiber.config !== 'object' || fiber.config === null)
                continue;
            const config = fiber.config;
            if (Array.isArray(config.customSkillDirs)) {
                for (const dir of config.customSkillDirs) {
                    if (typeof dir === 'string' && dir !== '')
                        custom.add(resolve(dir));
                }
            }
            if (typeof config.bundledSkillDir === 'string' && config.bundledSkillDir !== '') {
                bundled = config.bundledSkillDir;
                explicitBundled = true;
            }
            if (config.includeDefaultRoots === false)
                includeDefaults = false;
        }
    }
    const bundledSkillDir = includeDefaults || explicitBundled ? bundled : undefined;
    return {
        customSkillDirs: [...custom],
        bundledSkillDir: bundledSkillDir === '' ? undefined : bundledSkillDir,
    };
}
/**
 * Starting directory for project-root discovery.
 * Prefers the workspace path the page sent, then a real workspace on the host.
 * @param ctx - host context.
 * @param raw - absolute cwd from the browser, when it has one.
 * @returns a directory to walk upward from.
 */
function startCwd(ctx, raw) {
    if (typeof raw === 'string' && raw !== '' && isAbsolute(raw))
        return resolve(raw);
    const listed = ctx.workspaceRegistry.list().map((item) => item.path).filter((path) => !isJustChatPath(path));
    return listed[0] ?? process.cwd();
}
/**
 * Register the skill catalog routes.
 * @param ctx - scoped host context.
 */
function registerSkills(ctx) {
    ctx.connection.fetch.register({
        path: '/api/dsh-sidebar/skills',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
            try {
                request.signal.throwIfAborted();
                const cwd = startCwd(ctx, new URL(request.url).searchParams.get('cwd'));
                const projectRoot = await findProjectRoot(cwd);
                const config = filesystemConfig(ctx);
                const skills = await scanSkills(skillRoots(projectRoot, config.customSkillDirs, config.bundledSkillDir));
                return Response.json(skills);
            }
            catch (error) {
                return skillFailure(error);
            }
        },
    });
    ctx.connection.fetch.register({
        path: '/api/dsh-sidebar/skills/sources',
        methods: ['GET'],
        requestBody: 'buffered',
        async fetch(request) {
            try {
                request.signal.throwIfAborted();
                const cwd = startCwd(ctx, new URL(request.url).searchParams.get('cwd'));
                const projectRoot = await findProjectRoot(cwd);
                return Response.json({ candidates: await listInstallCandidates(projectRoot) });
            }
            catch (error) {
                return skillFailure(error);
            }
        },
    });
    ctx.connection.fetch.register({
        path: '/api/dsh-sidebar/skills/install',
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            try {
                request.signal.throwIfAborted();
                const body = await request.json();
                if (body.scope !== 'project' && body.scope !== 'global') {
                    return Response.json({ error: 'scope 只能是 project 或 global' }, { status: 400 });
                }
                if (typeof body.sourceDir !== 'string' || !isAbsolute(body.sourceDir)) {
                    return Response.json({ error: 'sourceDir 必须是绝对路径' }, { status: 400 });
                }
                const projectRoot = await findProjectRoot(startCwd(ctx, body.cwd));
                const installed = await installSkill(body.sourceDir, body.scope, projectRoot);
                return Response.json({ ok: true, ...installed });
            }
            catch (error) {
                return skillFailure(error);
            }
        },
    });
    ctx.connection.fetch.register({
        path: '/api/dsh-sidebar/skills/upload',
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            try {
                request.signal.throwIfAborted();
                if (typeof request.formData !== 'function')
                    return Response.json({ error: '上传内容无法解析' }, { status: 400 });
                const form = await request.formData();
                const scope = form.get('scope');
                if (scope !== 'project' && scope !== 'global') {
                    return Response.json({ error: 'scope 只能是 project 或 global' }, { status: 400 });
                }
                const archive = await uploadPart(form.get('archive'));
                const files = [];
                for (const item of form.getAll('files'))
                    files.push(await uploadPart(item));
                const parts = archive === undefined ? files.filter((item) => item !== undefined) : [archive];
                const projectRoot = await findProjectRoot(startCwd(ctx, form.get('cwd')));
                const installed = await installFromUpload(parts, scope, projectRoot);
                return Response.json({ ok: true, ...installed });
            }
            catch (error) {
                return skillFailure(error);
            }
        },
    });
    ctx.connection.fetch.register({
        path: '/api/dsh-sidebar/skills/toggle',
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            try {
                request.signal.throwIfAborted();
                const body = await request.json();
                if (typeof body.sourceDir !== 'string' || !isAbsolute(body.sourceDir)) {
                    return Response.json({ error: 'sourceDir 必须是绝对路径' }, { status: 400 });
                }
                if (typeof body.enabled !== 'boolean') {
                    return Response.json({ error: 'enabled 必须是布尔值' }, { status: 400 });
                }
                const projectRoot = await findProjectRoot(startCwd(ctx, body.cwd));
                await toggleSkill(body.sourceDir, body.enabled, projectRoot);
                return Response.json({ ok: true, enabled: body.enabled });
            }
            catch (error) {
                return skillFailure(error);
            }
        },
    });
}
/**
 * Map a thrown skill error onto a JSON response.
 * @param error - failure from a route.
 * @returns the HTTP response.
 */
function skillFailure(error) {
    if (error instanceof SkillError)
        return Response.json({ error: error.message }, { status: error.status });
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ error: message }, { status: 500 });
}
/**
 * Read one multipart file, ignoring text fields.
 * @param value - one form entry.
 * @returns the filename and bytes, or `undefined` when the entry is not a file.
 */
async function uploadPart(value) {
    if (value === null || typeof value !== 'object' || !('arrayBuffer' in value))
        return undefined;
    const file = value;
    if (typeof file.arrayBuffer !== 'function')
        return undefined;
    const name = typeof file.name === 'string' && file.name !== '' ? file.name : 'skill';
    return { name, bytes: new Uint8Array(await file.arrayBuffer()) };
}
/**
 * Ensure the single background directory exists and is registered.
 * @param ctx - host context.
 */
function registerRecent(ctx) {
    ctx.connection.fetch.register({
        path: PREPARE_ROUTE,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
            try {
                request.signal.throwIfAborted();
                const path = dshHomePath('dsh-sidebar', 'recent');
                await mkdir(path, { recursive: true });
                const existing = ctx.workspaceRegistry.list().find((workspace) => workspace.path === path);
                if (existing === undefined) {
                    await ctx.workspaceRegistry.create(path, RECENT_TITLE);
                }
                return Response.json({ path });
            }
            catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return Response.json({ error: message }, { status: 500 });
            }
        },
    });
}
