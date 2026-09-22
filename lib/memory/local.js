/**
 * SQLite memory backend.
 *
 * Uses the host runtime's `node:sqlite` binding, so the plugin adds no native
 * dependency. Vectors are stored as `float32` blobs and compared by brute-force
 * cosine similarity, which the reference design considers sufficient below a
 * few thousand rows.
 */
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { migrate } from './sql.js';
import { DUPLICATE_SIMILARITY, contentHash, cosine, decodeVector, encodeVector, ftsExpression, fuse, likeTerm, normalizeContent, } from './retrieve.js';
/** How many rows the vector retriever may scan in one query. */
const VECTOR_SCAN_LIMIT = 5000;
/** Candidates fetched per retriever before fusion. */
const PER_RETRIEVER_LIMIT = 20;
/**
 * Open a database handle through the runtime's SQLite binding.
 *
 * Loaded lazily through this module's own resolver: the binding exists only on
 * the host runtime, and a missing one must surface as a readable message rather
 * than a module-load crash.
 * @param dbPath - absolute file path.
 * @returns the open handle.
 */
function openDatabase(dbPath) {
    mkdirSync(dirname(dbPath), { recursive: true });
    const load = createRequire(import.meta.url);
    let sqlite;
    try {
        sqlite = load('node:sqlite');
    }
    catch (error) {
        throw new Error(`当前 Node 运行时不提供 node:sqlite，无法使用本地记忆存储：${error instanceof Error ? error.message : String(error)}`);
    }
    return new sqlite.DatabaseSync(dbPath);
}
/**
 * Split the stored tag column.
 * @param value - comma-separated tags.
 * @returns the tags.
 */
function readTags(value) {
    return value.split(',').map((tag) => tag.trim()).filter((tag) => tag !== '');
}
/**
 * Render tags for storage.
 *
 * Merges happen by concatenating tag lists, so deduplicate here to keep a
 * re-extracted fact from accumulating the same tag repeatedly.
 * @param tags - tags to store.
 * @returns comma-separated, trimmed, unique, non-empty tags.
 */
function writeTags(tags) {
    const unique = new Set();
    for (const tag of tags ?? []) {
        const trimmed = tag.trim();
        if (trimmed !== '')
            unique.add(trimmed);
    }
    return [...unique].join(',');
}
/** SQLite-backed {@link MemoryProvider}. */
export class LocalMemoryProvider {
    kind = 'local';
    db;
    embedder;
    /**
     * Open (and migrate) the database.
     * @param options - file path and vector source.
     */
    constructor(options) {
        this.db = openDatabase(options.dbPath);
        this.embedder = options.embedder;
        migrate(this.db);
    }
    /** {@inheritDoc MemoryProvider.health} */
    async health() {
        try {
            const total = await this.count();
            const vectors = this.embedder === undefined ? '未启用向量' : `向量 ${this.embedder.model}`;
            return { ok: true, kind: 'local', detail: `本地 SQLite，共 ${String(total)} 条记忆，${vectors}` };
        }
        catch (error) {
            return { ok: false, kind: 'local', detail: error instanceof Error ? error.message : String(error) };
        }
    }
    /** {@inheritDoc MemoryProvider.count} */
    async count() {
        const row = this.db.prepare('SELECT COUNT(*) AS total FROM memories').get();
        return Number(row?.total ?? 0);
    }
    /** {@inheritDoc MemoryProvider.write} */
    async write(draft) {
        const kind = draft.kind.trim() === '' ? 'fact' : draft.kind.trim();
        const content = normalizeContent(draft.content);
        const hash = contentHash(content);
        const existing = this.db.prepare('SELECT id, tags, confidence FROM memories WHERE content_hash = ?').get(hash);
        const now = Date.now();
        const vector = await this.embed(content);
        const tags = writeTags(draft.tags);
        if (existing === undefined) {
            // Two extraction passes phrase the same fact slightly differently; a
            // near-identical vector means it is the same memory, so merge instead of
            // storing a second row.
            const near = vector === undefined ? undefined : this.findNearDuplicate(vector.values);
            if (near !== undefined) {
                const row = this.db.prepare('SELECT content, tags, confidence FROM memories WHERE id = ?').get(near.id);
                const mergedTags = writeTags([...(row === undefined ? [] : readTags(row.tags)), ...(draft.tags ?? [])]);
                const confidence = Math.max(Number(row?.confidence ?? 0), clampConfidence(draft.confidence));
                this.db.prepare('UPDATE memories SET tags = ?, confidence = ?, updated_at = ? WHERE id = ?')
                    .run(mergedTags, confidence, now, near.id);
                this.syncFts(near.id, row?.content ?? content, mergedTags);
                return { id: near.id, created: false };
            }
        }
        const id = existing?.id ?? randomUUID();
        if (existing === undefined) {
            this.db.prepare(`INSERT INTO memories(
           id, kind, content, tags, source_session, source_workspace, confidence,
           embedding, embedding_dim, embedding_model, content_hash, created_at, updated_at
         ) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, kind, content, tags, draft.sourceSession ?? null, draft.sourceWorkspace ?? null, clampConfidence(draft.confidence), vector?.bytes ?? null, vector?.dim ?? 0, vector?.model ?? null, hash, now, now);
            this.syncFts(id, content, tags);
            return { id, created: true };
        }
        const mergedTags = writeTags([...readTags(existing.tags), ...(draft.tags ?? [])]);
        const confidence = Math.max(Number(existing.confidence) || 0, clampConfidence(draft.confidence));
        this.db.prepare(`UPDATE memories SET
         kind = ?, content = ?, tags = ?, source_session = COALESCE(?, source_session),
         source_workspace = COALESCE(?, source_workspace), confidence = ?,
         embedding = COALESCE(?, embedding), embedding_dim = COALESCE(?, embedding_dim),
         embedding_model = COALESCE(?, embedding_model), updated_at = ?
       WHERE id = ?`).run(kind, content, mergedTags, draft.sourceSession ?? null, draft.sourceWorkspace ?? null, confidence, vector?.bytes ?? null, vector?.dim ?? null, vector?.model ?? null, now, id);
        this.syncFts(id, content, mergedTags);
        return { id, created: false };
    }
    /** {@inheritDoc MemoryProvider.search} */
    async search(query) {
        const topK = Math.max(1, Math.trunc(query.topK));
        const rows = new Map();
        const label = (row) => { rows.set(row.id, row); };
        const keyword = [];
        const vector = [];
        if (query.fusion !== 'vector') {
            const expression = ftsExpression(query.text);
            const fts = expression === undefined ? [] : this.db.prepare(`SELECT m.* FROM memories_fts
           JOIN memories m ON m.id = memories_fts.memory_id
          WHERE memories_fts MATCH ?
          ORDER BY bm25(memories_fts)
          LIMIT ?`).all(expression, PER_RETRIEVER_LIMIT);
            fts.forEach(label);
            keyword.push({ name: 'fts', candidates: fts.map((row) => ({ id: row.id, score: 0 })) });
            // unicode61 tokenizes a whole CJK run as one token, so a substring query
            // finds nothing there; the LIKE pass is what keeps Chinese search working.
            const like = likeTerm(query.text);
            if (like !== undefined) {
                const pattern = `%${like}%`;
                const loose = this.db.prepare(`SELECT * FROM memories
            WHERE content LIKE ? OR tags LIKE ?
            ORDER BY updated_at DESC LIMIT ?`).all(pattern, pattern, PER_RETRIEVER_LIMIT);
                loose.forEach(label);
                keyword.push({ name: 'like', candidates: loose.map((row) => ({ id: row.id, score: 0 })) });
            }
        }
        if (query.fusion !== 'fulltext' && this.embedder !== undefined) {
            const vectors = await this.embedder.embed([query.text]);
            const probe = vectors[0];
            if (probe !== undefined && probe.length > 0) {
                const scored = [];
                const scanned = this.db.prepare(`SELECT * FROM memories WHERE embedding IS NOT NULL ORDER BY updated_at DESC LIMIT ?`).all(VECTOR_SCAN_LIMIT);
                for (const row of scanned) {
                    const stored = decodeVector(row.embedding);
                    if (stored.length === 0 || stored.length !== probe.length)
                        continue;
                    const score = cosine(probe, stored);
                    if (score <= 0)
                        continue;
                    rows.set(row.id, row);
                    scored.push({ id: row.id, score });
                }
                scored.sort((left, right) => right.score - left.score);
                vector.push({ name: 'vector', candidates: scored.slice(0, PER_RETRIEVER_LIMIT) });
            }
        }
        const ranked = query.fusion === 'vector'
            ? fuse(vector, { topK })
            : query.fusion === 'fulltext' ? fuse(keyword, { topK }) : fuse([...keyword, ...vector], { topK });
        return ranked.flatMap((candidate) => {
            const row = rows.get(candidate.id);
            if (row === undefined)
                return [];
            return [{ ...toHit(row), score: candidate.score, sources: candidate.sources }];
        });
    }
    /** {@inheritDoc MemoryProvider.list} */
    async list(options) {
        const limit = Math.min(200, Math.max(1, Math.trunc(options.limit)));
        const offset = Math.max(0, Math.trunc(options.offset));
        const text = (options.text ?? '').trim();
        if (text === '') {
            const rows = this.db.prepare('SELECT * FROM memories ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
            return rows.map((row) => ({ ...toHit(row), score: 0, sources: [] }));
        }
        const pattern = `%${text}%`;
        const rows = this.db.prepare(`SELECT * FROM memories
        WHERE content LIKE ? OR tags LIKE ? OR kind LIKE ?
        ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(pattern, pattern, pattern, limit, offset);
        return rows.map((row) => ({ ...toHit(row), score: 0, sources: [] }));
    }
    /** {@inheritDoc MemoryProvider.update} */
    async update(id, patch) {
        const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
        if (row === undefined)
            throw new Error('找不到这条记忆');
        const kind = patch.kind === undefined ? row.kind : patch.kind.trim() || row.kind;
        const content = patch.content === undefined ? row.content : normalizeContent(patch.content);
        const tags = patch.tags === undefined ? readTags(row.tags) : patch.tags;
        const hash = contentHash(content);
        const conflict = this.db.prepare('SELECT id FROM memories WHERE content_hash = ? AND id <> ?').get(hash, id);
        if (conflict !== undefined)
            throw new Error('已存在相同内容的记忆');
        const vector = content === row.content && kind === row.kind ? undefined : await this.embed(content);
        const now = Date.now();
        this.db.prepare(`UPDATE memories SET
         kind = ?, content = ?, tags = ?, confidence = ?, content_hash = ?,
         embedding = COALESCE(?, embedding), embedding_dim = COALESCE(?, embedding_dim),
         embedding_model = COALESCE(?, embedding_model), updated_at = ?
       WHERE id = ?`).run(kind, content, writeTags(tags), patch.confidence === undefined ? row.confidence : clampConfidence(patch.confidence), hash, vector?.bytes ?? null, vector?.dim ?? null, vector?.model ?? null, now, id);
        this.syncFts(id, content, writeTags(tags));
    }
    /** {@inheritDoc MemoryProvider.remove} */
    async remove(id) {
        this.deleteRow(id);
    }
    /** {@inheritDoc MemoryProvider.dedupe} */
    async dedupe() {
        const rows = this.db.prepare('SELECT id, content, tags, confidence, embedding FROM memories ORDER BY created_at ASC').all();
        const keepers = [];
        const byHash = new Map();
        let removed = 0;
        for (const row of rows) {
            const hash = contentHash(row.content);
            const index = byHash.get(hash);
            const tags = readTags(row.tags);
            const confidence = Number(row.confidence) || 0;
            if (index === undefined) {
                byHash.set(hash, keepers.length);
                keepers.push({ id: row.id, content: row.content, tags, confidence, vector: decodeVector(row.embedding) });
                continue;
            }
            const keeper = keepers[index];
            if (keeper === undefined)
                continue;
            keeper.tags = [...new Set([...keeper.tags, ...tags])];
            keeper.confidence = Math.max(keeper.confidence, confidence);
            this.writeKeeper(keeper);
            this.deleteRow(row.id);
            removed += 1;
        }
        for (let left = 0; left < keepers.length; left += 1) {
            const keeper = keepers[left];
            if (keeper === undefined || keeper.vector.length === 0)
                continue;
            for (let right = left + 1; right < keepers.length; right += 1) {
                const other = keepers[right];
                if (other === undefined || other.vector.length !== keeper.vector.length || other.vector.length === 0)
                    continue;
                if (cosine(keeper.vector, other.vector) < DUPLICATE_SIMILARITY)
                    continue;
                keeper.tags = [...new Set([...keeper.tags, ...other.tags])];
                keeper.confidence = Math.max(keeper.confidence, other.confidence);
                this.writeKeeper(keeper);
                this.deleteRow(other.id);
                other.vector = new Float32Array(0);
                removed += 1;
            }
        }
        return { removed };
    }
    /**
     * Persist the surviving row of a merge.
     * @param keeper - merged memory facts.
     */
    writeKeeper(keeper) {
        const tags = writeTags(keeper.tags);
        this.db.prepare('UPDATE memories SET tags = ?, confidence = ?, updated_at = ? WHERE id = ?')
            .run(tags, keeper.confidence, Date.now(), keeper.id);
        this.syncFts(keeper.id, keeper.content, tags);
    }
    /**
     * Delete one row and its fulltext entry.
     * @param id - memory id.
     */
    deleteRow(id) {
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
        this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    }
    /** {@inheritDoc MemoryProvider.reembedAll} */
    async reembedAll() {
        if (this.embedder === undefined)
            return { updated: 0, failed: 0 };
        const rows = this.db.prepare('SELECT id, content FROM memories ORDER BY updated_at DESC').all();
        let updated = 0;
        let failed = 0;
        for (const row of rows) {
            try {
                const vector = await this.embed(row.content);
                if (vector === undefined)
                    continue;
                this.db.prepare('UPDATE memories SET embedding = ?, embedding_dim = ?, embedding_model = ? WHERE id = ?').run(vector.bytes, vector.dim, vector.model, row.id);
                updated += 1;
            }
            catch {
                failed += 1;
            }
        }
        return { updated, failed };
    }
    /**
     * Replace the fulltext rows of one memory.
     * @param id - memory id.
     * @param content - indexed text.
     * @param tags - indexed tags.
     */
    syncFts(id, content, tags) {
        this.db.prepare('DELETE FROM memories_fts WHERE memory_id = ?').run(id);
        this.db.prepare('INSERT INTO memories_fts(memory_id, content, tags) VALUES(?, ?, ?)').run(id, content, tags);
    }
    /**
     * Embed one text when vectors are configured.
     * @param text - text to embed.
     * @returns the vector and its provenance, or `undefined` without an embedder.
     */
    async embed(text) {
        if (this.embedder === undefined)
            return undefined;
        const vectors = await this.embedder.embed([text]);
        const vector = vectors[0];
        if (vector === undefined || vector.length === 0)
            return undefined;
        return { bytes: encodeVector(vector), dim: vector.length, model: this.embedder.model, values: vector };
    }
    /**
     * Find a stored memory whose vector is effectively the same fact.
     * @param values - vector of the candidate memory.
     * @returns the closest row above {@link DUPLICATE_SIMILARITY}, when there is one.
     */
    findNearDuplicate(values) {
        if (values.length === 0)
            return undefined;
        const rows = this.db.prepare('SELECT id, embedding FROM memories WHERE embedding IS NOT NULL LIMIT ?').all(VECTOR_SCAN_LIMIT);
        let best;
        for (const row of rows) {
            const stored = decodeVector(row.embedding);
            if (stored.length !== values.length)
                continue;
            const similarity = cosine(values, stored);
            if (similarity < DUPLICATE_SIMILARITY)
                continue;
            if (best === undefined || similarity > best.similarity)
                best = { id: row.id, similarity };
        }
        return best;
    }
    /** {@inheritDoc MemoryProvider.close} */
    close() {
        this.db.close();
    }
}
/**
 * Clamp an optional confidence into `[0, 1]`.
 * @param value - raw confidence.
 * @returns the clamped value.
 */
function clampConfidence(value) {
    if (value === undefined || !Number.isFinite(value))
        return 1;
    return Math.min(1, Math.max(0, value));
}
/**
 * Project a stored row onto the public hit shape.
 * @param row - stored row.
 * @returns the memory value.
 */
function toHit(row) {
    return {
        id: row.id,
        kind: row.kind,
        content: row.content,
        tags: readTags(row.tags),
        ...(row.source_session === null ? {} : { sourceSession: row.source_session }),
        ...(row.source_workspace === null ? {} : { sourceWorkspace: row.source_workspace }),
        confidence: Number(row.confidence),
        createdAt: Number(row.created_at),
        updatedAt: Number(row.updated_at),
    };
}
