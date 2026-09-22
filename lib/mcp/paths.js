/**
 * Filesystem layout for the MCP feature.
 *
 * Everything this feature writes lives under the DSH profile directory, except
 * the `project` scope's list, which belongs to the repository the user is
 * working in and therefore sits next to that project's other DSH state.
 */
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CACHE_DIRNAME, GLOBAL_FILENAME, PROJECT_SUBDIR, SNAPSHOT_DIRNAME } from './constants.js';
/** The profile's user patch layer, which the Loader reads on every boot. */
export const PATCH_FILENAME = 'cordis.patch.yml';
/** Directory holding generated mount lists, under the profile. */
const SCRATCH_DIRNAME = '.mcp-settings-scratch';
/**
 * Resolve the DSH home directory.
 * @returns absolute home directory.
 */
export function resolveDshHome() {
    const explicit = process.env.DSH_HOME;
    return explicit !== undefined && explicit !== '' ? explicit : join(homedir(), '.dsh');
}
/**
 * Resolve the profile directory this host process booted from.
 * @returns absolute profile directory.
 */
export function resolveProfileDir() {
    const explicit = process.env.DSH_PROFILE_DIR;
    if (explicit !== undefined && explicit !== '')
        return explicit;
    return join(resolveDshHome(), 'profiles', process.env.DSH_PROFILE ?? 'web');
}
/**
 * Resolve the document backing one scope.
 * @param profileDir - absolute profile directory.
 * @param projectRoot - absolute project root; omit or pass '' for `global`.
 * @returns the absolute JSON path for that scope.
 */
export function scopedDocumentPath(profileDir, projectRoot) {
    if (projectRoot === undefined || projectRoot === '') {
        return join(profileDir, GLOBAL_FILENAME);
    }
    return join(projectRoot, PROJECT_SUBDIR, GLOBAL_FILENAME);
}
/**
 * Create a directory under the profile that holds disposable state.
 * @param profileDir - absolute profile directory.
 * @param name - directory name.
 * @returns the absolute directory, created when absent.
 */
function ensureProfileDir(profileDir, name) {
    const dir = join(profileDir, name);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
}
/**
 * Directory holding generated mount lists. Kept inside the profile so a
 * disposable file never leaks into the user's repository.
 * @param profileDir - absolute profile directory.
 * @returns absolute scratch directory.
 */
export function scratchDir(profileDir) {
    return ensureProfileDir(profileDir, SCRATCH_DIRNAME);
}
/**
 * Directory holding tool-discovery caches.
 * @param profileDir - absolute profile directory.
 * @returns absolute cache directory.
 */
export function cacheDir(profileDir) {
    return ensureProfileDir(profileDir, CACHE_DIRNAME);
}
/**
 * Directory holding configuration snapshots.
 * @param profileDir - absolute profile directory.
 * @returns absolute snapshot directory.
 */
export function snapshotDir(profileDir) {
    return ensureProfileDir(profileDir, SNAPSHOT_DIRNAME);
}
