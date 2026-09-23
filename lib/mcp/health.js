/**
 * Freshness, retry pacing, and aggregation for connection health.
 *
 * A verdict is a fact with a shelf life. Three rules keep the numbers honest:
 * a result older than {@link HEALTH_TTL_MS} is stale even if it said "healthy";
 * a failure schedules the next attempt instead of hammering the server; and a
 * credential failure stops automatic retries entirely, because retrying a
 * rejected token only risks a lockout and cannot succeed.
 *
 * A `stdio` entry is never auto-probed here. Its process belongs to the Host,
 * so the only way this module can learn anything about one is through the
 * optional observer the Host wires in — otherwise it stays `unknown`.
 */
import { BACKOFF_BASE_MS, BACKOFF_MAX_MS, BACKOFF_MAX_STEPS, HEALTH_TTL_MS } from './constants.js';
import { CONNECTION_STATE_LABELS, disabledDiagnostic, healthRow, summarize, unobservedDiagnostic, } from './diagnostics.js';
import { probeEntry } from './probe.js';
import { displayName, endpointLabel } from './schema.js';
/** Key one entry, since the same id can exist in both scopes. */
function keyOf(server) {
    return `${server.scope}:${server.id}`;
}
/**
 * Whether an entry participates in automatic re-checks.
 * @param server - entry to test.
 * @returns false for `stdio`, whose outcome only the Host can observe.
 */
function autoCheckable(server) {
    return server.transport !== 'stdio';
}
/** In-memory health state for the configured entries. */
export class HealthStore {
    /** Last row per entry. */
    rows = new Map();
    /** Last success timestamp per entry, which outlives a failing row. */
    successes = new Map();
    /** Backoff state per entry. */
    attempts = new Map();
    /** Entries whose automatic retries were stopped by a credential failure. */
    paused = new Set();
    /** How long a verdict stays fresh. */
    ttlMs;
    /** Injected clock, so tests can drive expiry without sleeping. */
    now;
    /**
     * @param options - `ttlMs` overrides the freshness window; `now` injects a clock.
     */
    constructor(options = {}) {
        this.ttlMs = options.ttlMs ?? HEALTH_TTL_MS;
        this.now = options.now ?? (() => Date.now());
    }
    /**
     * Every row currently held, in insertion order.
     * @returns the rows.
     */
    list() {
        return [...this.rows.values()];
    }
    /**
     * Read one entry's row.
     * @param server - entry to look up.
     * @returns the row, or undefined when it has not been checked.
     */
    get(server) {
        return this.rows.get(keyOf(server));
    }
    /**
     * Drop rows whose entry no longer exists in either scope.
     * @param servers - the entries that still exist.
     */
    retain(servers) {
        const live = new Set(servers.map(keyOf));
        for (const key of [...this.rows.keys()]) {
            if (!live.has(key))
                this.rows.delete(key);
        }
        for (const key of [...this.successes.keys()]) {
            if (!live.has(key))
                this.successes.delete(key);
        }
        for (const key of [...this.attempts.keys()]) {
            if (!live.has(key))
                this.attempts.delete(key);
        }
        for (const key of [...this.paused]) {
            if (!live.has(key))
                this.paused.delete(key);
        }
    }
    /**
     * Forget a single entry's state, used when its configuration changed.
     * @param server - entry to forget.
     */
    forget(server) {
        const key = keyOf(server);
        this.rows.delete(key);
        this.attempts.delete(key);
        this.paused.delete(key);
    }
    /**
     * Forget everything, used when the mounted set is rebuilt.
     */
    clear() {
        this.rows.clear();
        this.attempts.clear();
        this.paused.clear();
    }
    /**
     * Whether an automatic check is due for one entry.
     *
     * Disabled entries are never due, an entry under an authentication pause is
     * never due, and a `stdio` entry is never due because probing it teaches
     * nothing.
     * @param server - entry to test.
     * @returns true when the caller should probe it now.
     */
    due(server) {
        if (!server.enabled || !autoCheckable(server))
            return false;
        const key = keyOf(server);
        if (this.paused.has(key))
            return false;
        const row = this.rows.get(key);
        if (row === undefined)
            return true;
        const age = this.now() - Date.parse(row.checkedAt);
        if (Number.isNaN(age) || age >= this.ttlMs)
            return true;
        const attempt = this.attempts.get(key);
        return attempt !== undefined && attempt.retryAt <= this.now();
    }
    /**
     * Whether an entry's automatic retries are stopped by a credential failure.
     * @param server - entry to test.
     * @returns true when the entry is paused.
     */
    isPaused(server) {
        return this.paused.has(keyOf(server));
    }
    /**
     * Record a probe outcome and schedule the next attempt.
     * @param server - entry the result describes.
     * @param result - outcome of the probe.
     * @returns the row that was stored.
     */
    record(server, result) {
        const key = keyOf(server);
        if (result.ok) {
            this.successes.set(key, result.checkedAt);
            this.attempts.delete(key);
            this.paused.delete(key);
            const row = healthRow(server, result, { lastSuccessfulAt: result.checkedAt });
            this.rows.set(key, row);
            return row;
        }
        if (result.kind === 'auth' || result.kind === 'authorization-required') {
            // Retrying a rejected credential cannot succeed and can trip a lockout,
            // so the entry waits for the user instead of the timer.
            this.paused.add(key);
            this.attempts.delete(key);
            const row = healthRow(server, result, { lastSuccessfulAt: this.successes.get(key), paused: true });
            this.rows.set(key, row);
            return row;
        }
        const previous = this.attempts.get(key);
        const step = Math.min((previous?.step ?? 0) + 1, BACKOFF_MAX_STEPS);
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** (step - 1), BACKOFF_MAX_MS);
        const requested = result.retryAfterMs ?? 0;
        const retryAt = this.now() + Math.max(delay, requested);
        this.attempts.set(key, { step, retryAt });
        const row = healthRow(server, result, { lastSuccessfulAt: this.successes.get(key), retryAt });
        this.rows.set(key, row);
        return row;
    }
    /**
     * Store the placeholder row for an entry that is configured but switched off.
     * @param server - entry to describe.
     * @returns the row that was stored.
     */
    recordDisabled(server) {
        const row = this.placeholder(server, disabledDiagnostic(new Date().toISOString()), false);
        this.rows.set(keyOf(server), row);
        return row;
    }
    /**
     * Store the placeholder row for an entry that has never been observed.
     * @param server - entry to describe.
     * @returns the row that was stored.
     */
    recordUnobserved(server) {
        const diagnostic = unobservedDiagnostic(new Date().toISOString(), this.successes.get(keyOf(server)));
        const row = this.placeholder(server, diagnostic, server.enabled);
        this.rows.set(keyOf(server), row);
        return row;
    }
    /**
     * Build a row from a diagnostic that has no probe behind it.
     * @param server - entry to describe.
     * @param diagnostic - verdict to wrap.
     * @param enabled - whether the entry is mounted.
     * @returns the row.
     */
    placeholder(server, diagnostic, enabled) {
        return {
            ...diagnostic,
            id: server.id,
            name: displayName(server),
            label: CONNECTION_STATE_LABELS[diagnostic.state],
            scope: server.scope,
            transport: server.transport,
            enabled,
            endpoint: endpointLabel(server),
            ok: false,
        };
    }
    /**
     * Aggregate the current rows.
     * @returns the summary the page renders.
     */
    summary() {
        return summarize(this.list());
    }
}
/**
 * Bring every entry's verdict up to date, then summarize.
 *
 * Only enabled entries are probed, and only those whose verdict is missing,
 * stale, or past their backoff. Everything else keeps its previous row, so a
 * page load is cheap and a failing server is not retried on every keystroke.
 * @param store - health state to update.
 * @param servers - every configured entry, both scopes.
 * @param options - forcing, observer, and probe settings.
 * @returns the pass outcome.
 */
export async function ensureHealth(store, servers, options = {}) {
    store.retain(servers);
    const checked = [];
    const skipped = [];
    const targets = [];
    const only = options.only === undefined ? undefined : new Set(options.only.map(entry => keyOf(entry)));
    for (const server of servers) {
        if (!server.enabled) {
            store.recordDisabled(server);
            continue;
        }
        const forced = only?.has(keyOf(server)) === true;
        if (only !== undefined && !forced) {
            // A pass scoped to one entry says nothing about the others, so their rows
            // are left exactly as they were rather than downgraded to "unknown".
            if (store.get(server) === undefined)
                store.recordUnobserved(server);
            skipped.push(`${server.scope}:${server.id}`);
            continue;
        }
        if (options.defer !== true && (forced || options.force === true || store.due(server))) {
            targets.push(server);
            checked.push(`${server.scope}:${server.id}`);
            continue;
        }
        if (store.get(server) === undefined)
            store.recordUnobserved(server);
        skipped.push(`${server.scope}:${server.id}`);
    }
    const results = await Promise.all(targets.map(async (server) => {
        const observed = options.observe?.(server);
        if (observed !== undefined)
            return { server, result: observed };
        return { server, result: await probeEntry(server, options) };
    }));
    for (const { server, result } of results)
        store.record(server, result);
    return { summary: store.summary(), checked, skipped };
}
