/**
 * Ranking primitives: content hashing, FTS/LIKE query building, cosine
 * similarity, and Reciprocal Rank Fusion.
 *
 * Everything here is pure so `node --test` covers the retrieval math without a
 * database, a network, or a browser.
 */
import { createHash } from 'node:crypto';
/** RRF damping constant; 60 matches the value used by the reference systems. */
export const RRF_K = 60;
/** Shortest fact worth storing; below this the row is noise. */
const MIN_CONTENT_LENGTH = 4;
/** Cosine above which two vectors are treated as the same remembered fact. */
export const DUPLICATE_SIMILARITY = 0.985;
/**
 * Collapse whitespace so the same fact typed twice reads the same.
 * @param value - raw text.
 * @returns the normalized text.
 */
export function normalizeContent(value) {
    return value.replace(/\s+/g, ' ').trim();
}
/**
 * Reduce text to the shape two phrasings of one fact share.
 *
 * Two extraction passes routinely differ by a trailing full stop, punctuation
 * width, or spacing; those are not different memories, so punctuation and
 * symbols are dropped before hashing.
 * @param value - raw text.
 * @returns lowercase letters, digits, and CJK only.
 */
export function canonicalContent(value) {
    return normalizeContent(value.normalize('NFKC')).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}
/**
 * Stable identity for deduplication, independent of punctuation and case.
 * @param content - memory text.
 * @returns hex sha256 over the canonical text.
 */
export function contentHash(content) {
    return createHash('sha256').update(canonicalContent(content)).digest('hex');
}
/**
 * Whether a fact is worth persisting.
 * @param kind - memory taxonomy.
 * @param content - memory text.
 * @returns `true` when the row passes the length gate.
 */
export function isStorable(kind, content) {
    return kind.trim() !== '' && normalizeContent(content).length >= MIN_CONTENT_LENGTH;
}
/**
 * Split a user query into FTS5 terms, dropping syntax the tokenizer cannot use.
 * CJK text has no spaces, so each ideograph run is also emitted as one term.
 * @param text - raw query.
 * @returns deduplicated terms; empty when the query carries no usable token.
 */
export function ftsTerms(text) {
    const terms = new Set();
    for (const token of text.split(/[^\p{L}\p{N}_]+/u)) {
        if (token.length === 0)
            continue;
        terms.add(token);
        for (const run of token.match(/[\p{Script=Han}]+/gu) ?? []) {
            if (run.length > 1)
                terms.add(run);
        }
    }
    return [...terms];
}
/**
 * Build an FTS5 `MATCH` expression from a query.
 * @param text - raw query.
 * @returns the expression, or `undefined` when there is nothing to search.
 */
export function ftsExpression(text) {
    const terms = ftsTerms(text);
    if (terms.length === 0)
        return undefined;
    return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}
/**
 * Longest term of a query, used for the `LIKE` fallback that keeps CJK
 * substring queries working when the tokenizer finds nothing.
 * @param text - raw query.
 * @returns the term, or `undefined` when the query has none.
 */
export function likeTerm(text) {
    const terms = ftsTerms(text);
    if (terms.length === 0)
        return undefined;
    return terms.reduce((best, term) => (term.length > best.length ? term : best), '');
}
/**
 * Cosine similarity, treating a zero vector as "no similarity".
 * @param left - first vector.
 * @param right - second vector.
 * @returns similarity in `[-1, 1]`; `0` when either vector is empty or zero.
 */
export function cosine(left, right) {
    const length = Math.min(left.length, right.length);
    let dot = 0;
    let leftNorm = 0;
    let rightNorm = 0;
    for (let index = 0; index < length; index += 1) {
        const a = left[index] ?? 0;
        const b = right[index] ?? 0;
        dot += a * b;
        leftNorm += a * a;
        rightNorm += b * b;
    }
    if (leftNorm === 0 || rightNorm === 0)
        return 0;
    return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}
/**
 * Drop entries whose text is too short or too long to be one fact.
 * @param entries - raw candidates.
 * @param maxLength - per-entry character cap.
 * @returns the accepted entries.
 */
export function compactEntries(entries, maxLength = 400) {
    const accepted = [];
    for (const entry of entries) {
        const content = normalizeContent(entry.content);
        if (!isStorable(entry.kind, content))
            continue;
        if (content.length > maxLength)
            continue;
        accepted.push({ ...entry, content });
    }
    return accepted;
}
/**
 * Reciprocal Rank Fusion over named retriever result lists.
 * @param lists - one list per retriever, best candidate first.
 * @param options - damping constant and result cap.
 * @returns candidates ordered by fused score, with the retrievers that found them.
 */
export function fuse(lists, options = { topK: 5 }) {
    const k = options.k ?? RRF_K;
    const scores = new Map();
    const sources = new Map();
    for (const list of lists) {
        list.candidates.forEach((candidate, index) => {
            scores.set(candidate.id, (scores.get(candidate.id) ?? 0) + 1 / (k + index + 1));
            const found = sources.get(candidate.id) ?? new Set();
            found.add(list.name);
            sources.set(candidate.id, found);
        });
    }
    return [...scores.entries()]
        .map(([id, score]) => ({ id, score, sources: [...(sources.get(id) ?? [])].sort() }))
        .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1))
        .slice(0, Math.max(0, options.topK));
}
/**
 * Weighted merge used when only one retriever should decide the order.
 * @param name - retriever label recorded on each hit.
 * @param candidates - candidates already ordered by that retriever.
 * @param topK - result cap.
 * @returns the merged ranking.
 */
export function singleList(name, candidates, topK) {
    return candidates.slice(0, Math.max(0, topK)).map((candidate) => ({ ...candidate, sources: [name] }));
}
/**
 * Encode a float vector for SQLite storage.
 * @param vector - values to store.
 * @returns the little-endian `float32` byte view.
 */
export function encodeVector(vector) {
    const floats = new Float32Array(vector.length);
    for (let index = 0; index < vector.length; index += 1)
        floats[index] = vector[index] ?? 0;
    return new Uint8Array(floats.buffer, floats.byteOffset, floats.byteLength);
}
/**
 * Decode a stored vector.
 * @param value - bytes previously produced by {@link encodeVector}.
 * @returns the float view, empty when the bytes are absent or misaligned.
 */
export function decodeVector(value) {
    if (!(value instanceof Uint8Array))
        return new Float32Array(0);
    if (value.byteLength === 0 || value.byteLength % 4 !== 0)
        return new Float32Array(0);
    const copy = value.slice().buffer;
    return new Float32Array(copy);
}
