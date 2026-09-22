/**
 * SQLite schema and migrations for the local memory backend.
 *
 * The statement surface is declared structurally so the plugin compiles
 * without pulling `node:sqlite` types; the runtime object is the host's
 * `DatabaseSync`.
 */
import { contentHash } from './retrieve.js';
/** Schema revision written into `memory_meta.schema_version`. */
export const SCHEMA_VERSION = 2;
/** Statements creating a fresh database at {@link SCHEMA_VERSION}. */
const CREATE_STATEMENTS = [
    `CREATE TABLE IF NOT EXISTS memory_meta (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
    `CREATE TABLE IF NOT EXISTS memories (
     id TEXT PRIMARY KEY,
     kind TEXT NOT NULL,
     content TEXT NOT NULL,
     tags TEXT NOT NULL DEFAULT '',
     source_session TEXT,
     source_workspace TEXT,
     confidence REAL NOT NULL DEFAULT 1,
     embedding BLOB,
     embedding_dim INTEGER NOT NULL DEFAULT 0,
     embedding_model TEXT,
     content_hash TEXT NOT NULL UNIQUE,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
    'CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_memories_kind ON memories(kind)',
    `CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5 (
     memory_id UNINDEXED,
     content,
     tags,
     tokenize = 'unicode61'
   )`,
    `CREATE TABLE IF NOT EXISTS memory_seen (
     session_id TEXT NOT NULL,
     seq INTEGER NOT NULL,
     PRIMARY KEY (session_id, seq)
   )`,
];
/**
 * Create or upgrade the schema.
 * @param db - open database.
 * @returns the revision in force after the call.
 */
export function migrate(db) {
    db.exec('PRAGMA journal_mode = WAL');
    for (const statement of CREATE_STATEMENTS)
        db.exec(statement);
    const current = readVersion(db);
    if (current === 0) {
        writeVersion(db, SCHEMA_VERSION);
        return SCHEMA_VERSION;
    }
    if (current < 2)
        rehashContents(db);
    if (current < SCHEMA_VERSION)
        writeVersion(db, SCHEMA_VERSION);
    return Math.max(current, SCHEMA_VERSION);
}
/**
 * Recompute stored identities with the punctuation-insensitive scheme.
 *
 * Revision 1 hashed `kind + raw content`, so one fact phrased twice (a trailing
 * full stop, different spacing) lived as two rows. Rows that collapse onto the
 * same canonical identity are merged into the oldest survivor here.
 * @param db - open database.
 */
function rehashContents(db) {
    const rows = db.prepare('SELECT id, content, tags, content_hash FROM memories ORDER BY created_at ASC')
        .all();
    const keepers = new Map();
    for (const row of rows) {
        const hash = contentHash(row.content);
        const keeper = keepers.get(hash);
        if (keeper === undefined) {
            keepers.set(hash, row.id);
            if (hash !== row.content_hash) {
                db.prepare('UPDATE memories SET content_hash = ? WHERE id = ?').run(hash, row.id);
            }
            // Survivors keep one fulltext row, whatever revision wrote them.
            db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(row.id);
            db.prepare('INSERT INTO memories_fts(memory_id, content, tags) VALUES(?, ?, ?)').run(row.id, row.content, row.tags);
            continue;
        }
        db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(row.id);
        db.prepare('DELETE FROM memories WHERE id = ?').run(row.id);
    }
}
/**
 * Read the stored schema revision.
 * @param db - open database.
 * @returns the revision, or `0` for a database that predates versioning.
 */
function readVersion(db) {
    const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get('schema_version');
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}
/**
 * Persist the schema revision.
 * @param db - open database.
 * @param version - revision to store.
 */
function writeVersion(db, version) {
    db.prepare('INSERT INTO memory_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run('schema_version', String(version));
}
/**
 * Read one integer counter from `memory_meta`.
 * @param db - open database.
 * @param key - counter name.
 * @returns the parsed value, or `0` when absent.
 */
export function readCounter(db, key) {
    const row = db.prepare('SELECT value FROM memory_meta WHERE key = ?').get(key);
    const parsed = Number(row?.value);
    return Number.isFinite(parsed) ? parsed : 0;
}
/**
 * Write one integer counter into `memory_meta`.
 * @param db - open database.
 * @param key - counter name.
 * @param value - value to store.
 */
export function writeCounter(db, key, value) {
    db.prepare('INSERT INTO memory_meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(key, String(value));
}
