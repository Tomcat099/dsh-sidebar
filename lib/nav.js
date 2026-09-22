/** Directories that stay off the project tree and feed 「最近对话」. */
const RECENT_SEGMENTS = ['dsh-sidebar/recent', 'just-chat/sessions'];
/** How many recent chats stay visible before the expand row. */
export const RECENT_LIMIT = 5;
/**
 * Whether a workspace is the hidden background project for 「最近对话」.
 * Includes directories left by the old per-chat layout.
 * @param path - absolute workspace path, either slash style.
 * @returns true when the path should not appear under 「项目」.
 */
export function isJustChatPath(path) {
    const normalized = path.replaceAll('\\', '/');
    return RECENT_SEGMENTS.some(segment => normalized.includes(segment));
}
/**
 * Workspaces that belong in the project tree.
 * @param items - host workspace list.
 * @returns items whose path is not a quick-chat directory.
 */
export function projectWorkspaces(items) {
    return items.filter(item => !isJustChatPath(item.path));
}
/**
 * Quick-chat workspaces that must leave the project tree.
 * @param items - host workspace list.
 * @returns items created for 「最近对话」, not user projects.
 */
export function justChatWorkspaces(items) {
    return items.filter(item => isJustChatPath(item.path));
}
/**
 * Project that owns the current session, if the user is inside a real project.
 * A quick-chat workspace does not count as a selected project.
 * @param items - host workspace list.
 * @param currentSessionId - selected session, when one is open.
 * @returns the project workspace id, or undefined when none is selected.
 */
export function currentProjectId(items, currentSessionId) {
    if (currentSessionId === undefined || currentSessionId === '')
        return undefined;
    return items.find(item => !isJustChatPath(item.path) && item.sessionIds.includes(currentSessionId))?.workspaceId;
}
/**
 * Flat recent list for quick-chat history.
 * @param workspaces - host workspace list.
 * @param sessions - session summaries keyed by id.
 * @param archived - session ids the host has archived.
 * @returns visible sessions, newest first. Archived rows are omitted. Blank sessions stay, so a new chat shows up immediately.
 */
export function recentSessions(workspaces, sessions, archived) {
    const rows = [];
    const seen = new Set();
    for (const workspace of justChatWorkspaces(workspaces)) {
        for (const id of workspace.sessionIds) {
            if (seen.has(id) || archived.has(id))
                continue;
            const session = sessions[id];
            if (session === undefined)
                continue;
            seen.add(id);
            rows.push(session);
        }
    }
    rows.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return rows;
}
/**
 * Compact relative time matching the existing sidebar ("40分钟", "3小时").
 * @param updatedAt - last activity, epoch milliseconds.
 * @param now - clock used for the delta.
 * @returns a short Chinese label without a trailing "前".
 */
export function relativeTime(updatedAt, now) {
    const minutes = Math.floor(Math.max(0, now - updatedAt) / 60_000);
    if (minutes < 1)
        return '刚刚';
    if (minutes < 60)
        return `${String(minutes)}分钟`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24)
        return `${String(hours)}小时`;
    return `${String(Math.floor(hours / 24))}天`;
}
/**
 * Default quick-chat workspace title, same shape as dsh-just-chat.
 * @param now - local clock.
 * @returns a title such as `快速对话 · 09-17 15:03`.
 */
export function justChatTitle(now = new Date()) {
    const pad = (value) => String(value).padStart(2, '0');
    return `快速对话 · ${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
}
