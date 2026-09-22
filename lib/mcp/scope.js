/**
 * The two lists an MCP server can live in, and the operations that move
 * configuration between them.
 *
 * `global` lives in the profile directory and applies everywhere. `project`
 * lives in `<project>/.dsh/` and applies only while that project is the active
 * workspace. Both are ordinary documents; nothing about an entry is duplicated
 * across them, and no credential ever moves when an entry does.
 *
 * Every commit is guarded by an expected revision. That is what lets the UI say
 * "someone else changed this while you were editing" instead of silently
 * clobbering the other write.
 */
import { scopedDocumentPath } from './paths.js';
import { validateDocument } from './schema.js';
import { createSnapshot, listSnapshots, previewRestore, readSnapshot } from './snapshot.js';
import { documentExists, readDocument, writeDocument } from './store.js';
/**
 * Load the profile-wide list.
 * @param profileDir - absolute profile directory.
 * @returns the view, with an empty document when nothing is stored yet.
 */
export function globalView(profileDir) {
    const file = scopedDocumentPath(profileDir);
    const doc = readDocument(file);
    return {
        scope: 'global',
        file,
        revision: doc.revision,
        servers: doc.servers,
        present: documentExists(file),
    };
}
/**
 * Load one project's list.
 * @param profileDir - absolute profile directory.
 * @param projectRoot - absolute project root.
 * @returns the view, with an empty document when nothing is stored yet.
 */
export function projectView(profileDir, projectRoot) {
    const file = scopedDocumentPath(profileDir, projectRoot);
    const doc = readDocument(file);
    return {
        scope: 'project',
        root: projectRoot,
        file,
        revision: doc.revision,
        servers: doc.servers,
        present: documentExists(file),
    };
}
/**
 * Load both lists.
 * @param profileDir - absolute profile directory.
 * @param activeProjectRoot - absolute project root, when a workspace is open.
 * @returns the context.
 */
export function readContext(profileDir, activeProjectRoot) {
    const context = { profileDir, global: globalView(profileDir) };
    if (activeProjectRoot !== undefined && activeProjectRoot !== '') {
        context.activeProjectRoot = activeProjectRoot;
        context.project = projectView(profileDir, activeProjectRoot);
    }
    return context;
}
/**
 * Resolve one scope's view.
 * @param context - loaded context.
 * @param scope - scope wanted.
 * @returns the view, or undefined when the project scope has no active project.
 */
export function viewFor(context, scope) {
    return scope === 'global' ? context.global : context.project;
}
/**
 * Flatten both lists into one annotated list.
 *
 * The global list comes first so a project entry with the same id shadows it in
 * the UI, matching how a narrower scope is expected to behave.
 * @param context - loaded context.
 * @returns entries tagged with the scope they came from.
 */
export function allServers(context) {
    const rows = context.global.servers.map(entry => ({ ...entry, scope: 'global' }));
    for (const entry of context.project?.servers ?? [])
        rows.push({ ...entry, scope: 'project' });
    return rows;
}
/**
 * The servers the Host should mount right now.
 *
 * A project entry with the same id as a global one wins, so a repository can
 * override a shared definition without editing the global list.
 * @param context - loaded context.
 * @returns enabled entries, global first, deduplicated by id.
 */
export function mountableServers(context) {
    const byId = new Map();
    for (const entry of context.global.servers)
        byId.set(entry.id, { ...entry, scope: 'global' });
    for (const entry of context.project?.servers ?? [])
        byId.set(entry.id, { ...entry, scope: 'project' });
    return [...byId.values()].filter(entry => entry.enabled);
}
/**
 * Validate and commit one document.
 *
 * The order matters: validation first so a rejected save never touches disk, an
 * automatic checkpoint second so the previous revision can be restored, and the
 * write last with the revision guard still in force.
 * @param context - loaded context, so snapshots land under the profile.
 * @param scope - scope being written.
 * @param doc - candidate document.
 * @param options - `expectedRevision` guards against a lost update.
 * @returns the outcome; nothing is written when validation fails.
 */
export function commit(context, scope, doc, options = {}) {
    const view = viewFor(context, scope);
    if (view === undefined)
        return { ok: false, message: '当前没有打开的项目，无法使用项目级配置' };
    const verdict = validateDocument(doc);
    if (!verdict.ok) {
        return { ok: false, message: verdict.issues.map(issue => issue.message).join('；'), issues: verdict.issues };
    }
    // A checkpoint of an empty document would only push real ones out of the
    // capped history, so the very first save of a scope takes no snapshot.
    const previous = readDocument(view.file);
    const snapshot = view.present && previous.servers.length > 0
        ? createSnapshot(context.profileDir, scope, previous, { kind: 'auto' })
        : undefined;
    const outcome = writeDocument(view.file, doc, options);
    if (outcome.conflicted) {
        return {
            ok: false,
            conflicted: true,
            message: '这份配置在你编辑期间被改动过，请刷新后重试',
            current: outcome.stored,
        };
    }
    const result = { ok: true, message: '已保存', stored: outcome.stored };
    if (snapshot !== undefined)
        result.snapshot = snapshot;
    return result;
}
/**
 * Move or copy entries between the two scopes.
 *
 * Credentials never travel: an entry keeps its `headerEnv` / `envEnv` names, so
 * the receiving scope depends on the same environment variables the sending one
 * did. Nothing is written unless every moved entry validates.
 * @param context - loaded context.
 * @param input - source, target, ids, and whether to copy or move.
 * @returns the outcome, plus the target document as it would be written.
 */
export function transferBetween(context, input) {
    const from = viewFor(context, input.from);
    const to = viewFor(context, input.to);
    if (from === undefined)
        return { ok: false, message: '当前没有打开的项目，无法使用项目级配置' };
    if (to === undefined)
        return { ok: false, message: '当前没有打开的项目，无法使用项目级配置' };
    if (input.from === input.to)
        return { ok: false, message: '来源和作用域相同，不需要搬移' };
    const picked = from.servers.filter(entry => input.ids.includes(entry.id));
    if (picked.length === 0)
        return { ok: false, message: '没有选中任何一条' };
    const existing = new Set(to.servers.map(entry => entry.id));
    const collisions = picked.filter(entry => existing.has(entry.id)).map(entry => entry.id);
    if (collisions.length > 0) {
        return { ok: false, message: `目标作用域已有同名条目：${collisions.join('、')}。请先改名或删除后重试` };
    }
    const carried = picked.map(entry => ({ ...entry }));
    const target = { revision: to.revision, servers: [...to.servers, ...carried] };
    const verdict = validateDocument(target);
    if (!verdict.ok) {
        return { ok: false, message: '搬移后会不合法，已取消', issues: verdict.issues };
    }
    if (input.mode === 'copy')
        return { ok: true, message: `已复制 ${String(carried.length)} 条到${scopeLabel(input.to)}`, target };
    const source = {
        revision: from.revision,
        servers: from.servers.filter(entry => !input.ids.includes(entry.id)),
    };
    return {
        ok: true,
        message: `已移动 ${String(carried.length)} 条到${scopeLabel(input.to)}`,
        target,
        source,
    };
}
/**
 * Describe what restoring a snapshot would change.
 * @param context - loaded context.
 * @param scope - scope whose snapshot is being restored.
 * @param id - snapshot identifier.
 * @returns the preview payload, or a failure when the scope or snapshot is gone.
 */
export function previewScopeRestore(context, scope, id) {
    const view = viewFor(context, scope);
    if (view === undefined)
        return { ok: false, message: '当前没有打开的项目，无法使用项目级配置' };
    return previewRestore(context.profileDir, scope, id, { revision: view.revision, servers: view.servers });
}
/**
 * Load a snapshot body for display.
 * @param context - loaded context.
 * @param scope - scope the snapshot belongs to.
 * @param id - snapshot identifier.
 * @returns the captured document, or undefined when it is gone.
 */
export function snapshotDocument(context, scope, id) {
    return readSnapshot(context.profileDir, scope, id);
}
/**
 * List a scope's snapshot history.
 * @param context - loaded context.
 * @param scope - scope whose history is wanted.
 * @returns metadata, newest first.
 */
export function snapshotHistory(context, scope) {
    return listSnapshots(context.profileDir, scope);
}
/**
 * Chinese label for one scope.
 * @param scope - scope to name.
 * @returns the label used in messages.
 */
export function scopeLabel(scope) {
    return scope === 'global' ? '全局' : '当前项目';
}
