/**
 * Memory feature wiring.
 *
 * Owns the resolved configuration, the backend instance, recall caching, and
 * the session events that drive automatic extraction. Everything it exposes to
 * the outside world goes through {@link MemoryApi}.
 */
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm';
import { Config, MEMORY_CONFIG_KEYS, MEMORY_NS, resolveMemoryConfig, resolveMemoryDb, } from './config.js';
import { DEFAULT_EXPLICIT_KEYWORDS, collectTurnMessages, extractMemories, hasExplicitRequest, } from './extract.js';
import { createProvider, providerSignature } from './provider.js';
import { RECALL_CONTEXT_NAME, RECALL_ORDER, RecallCache } from './recall.js';
import { registerMemoryRoutes } from './routes.js';
import { memoryTools } from './tools.js';
export { Config, MEMORY_NS } from './config.js';
/** Quiet period after the last assistant message before extraction runs. */
const EXTRACT_QUIET_MS = 8_000;
/** Delay before refreshing the recall block for a new user message. */
const RECALL_DEBOUNCE_MS = 300;
/** Existing contents compared against during extraction. */
const EXISTING_SAMPLE = 8;
/** Model answer budget for one extraction. */
const EXTRACT_MAX_TOKENS = 1_200;
/** Transcript lines kept when an explicit "remember this" triggers extraction. */
const EXPLICIT_WINDOW_LINES = 20;
/**
 * Interval of the active sweep over live sessions.
 *
 * Session events are the fast path, but they only arrive if this plugin's
 * context is inside the emitting scope, so the sweep is what guarantees the
 * feature works at all.
 */
const SWEEP_MS = 5_000;
/**
 * How often the always-on block is rebuilt outside of explicit writes.
 *
 * A conversation's first turn is assembled before any lookup can finish, so
 * stable preferences must already be cached when that turn starts.
 */
const STANDING_REFRESH_MS = 60_000;
/**
 * Delay before writing an observed embedding dimension back into settings.
 *
 * The write re-creates the backend, which must not happen while a query or a
 * write is still using it.
 */
const DIM_SYNC_DELAY_MS = 1_500;
/** Runtime that backs the routes, tools, recall injection, and extraction. */
class MemoryRuntime {
    ctx;
    composition;
    sectionSource;
    handle;
    recall = new RecallCache();
    sessions = new Map();
    timers = new Set();
    diagnostics = {
        events: 0,
        sweeps: 0,
        wiring: { tools: false, systemPrompt: false, agents: false, llm: false, settings: false },
    };
    llm;
    agentRegistry;
    settings;
    observedDim;
    dimSyncing = false;
    activeOperations = 0;
    staleHandle = false;
    standingAt = 0;
    /**
     * @param ctx - host context.
     * @param composition - config from the plugin composition entry.
     */
    constructor(ctx, composition) {
        this.ctx = ctx;
        this.composition = composition;
        this.sectionSource = () => composition;
    }
    /** Register every host hook owned by the feature. */
    start() {
        this.ctx.inject(['settings'], (scoped) => {
            const settings = scoped.settings;
            if (settings === undefined)
                return;
            this.settings = settings;
            this.diagnostics.wiring.settings = true;
            settings.installSection(this.ctx, MEMORY_NS, Config, this.composition, {
                setSource: (source) => {
                    this.sectionSource = source;
                    this.invalidate();
                },
                onChange: () => { this.invalidate(); },
            });
        });
        this.ctx.inject(['connection'], (scoped) => {
            registerMemoryRoutes(scoped, this.api());
        });
        this.ctx.inject(['tools'], (scoped) => {
            const registry = scoped.tools;
            if (registry === undefined)
                return;
            this.diagnostics.wiring.tools = true;
            for (const tool of memoryTools({
                provider: () => this.provider(),
                complaint: () => this.complaint(),
                topK: () => this.config().recallTopK,
            }))
                registry.register(tool);
        });
        this.ctx.inject(['systemPrompt'], (scoped) => {
            const prompt = scoped.systemPrompt;
            if (prompt === undefined)
                return;
            this.diagnostics.wiring.systemPrompt = true;
            prompt.context({
                name: RECALL_CONTEXT_NAME,
                order: RECALL_ORDER,
                text: (context) => {
                    if (!this.config().autoRecall)
                        return '';
                    return this.recall.get(sessionIdOf(context));
                },
            });
        });
        // `llm` and `agents` are isolated services: reading them off the outer
        // context throws "without inject", so they must arrive through inject.
        this.ctx.inject(['agents'], (scoped) => {
            this.agentRegistry = scoped.agents;
            this.diagnostics.wiring.agents = this.agentRegistry !== undefined;
        });
        this.ctx.inject(['llm'], (scoped) => {
            this.llm = scoped.llm;
            this.diagnostics.wiring.llm = this.llm !== undefined;
        });
        if (typeof this.ctx.on === 'function') {
            this.ctx.on('session/event', (...args) => {
                const [session, event] = args;
                if (session === undefined || event === undefined)
                    return;
                this.onSessionEvent(session, event);
            });
        }
        const sweep = this.track(setInterval(() => {
            try {
                this.sweep();
            }
            catch (error) {
                this.warn(`sweep failed: ${String(error)}`);
            }
        }, SWEEP_MS));
        sweep.unref?.();
        this.ctx.effect(() => () => {
            for (const timer of this.timers)
                clearTimeout(timer);
            this.timers.clear();
            this.handle?.provider?.close?.();
            this.handle = undefined;
        }, 'dsh-sidebar: memory lifecycle');
    }
    /**
     * Current resolved configuration.
     * @returns the memory settings in force.
     */
    config() {
        return resolveMemoryConfig(this.sectionSource());
    }
    /**
     * Reason the backend cannot serve requests, when there is one.
     * @returns the complaint, or `undefined`.
     */
    complaint() {
        return this.handleFor().complaint;
    }
    /**
     * Active backend.
     * @returns the provider, or `undefined` when the configuration is unusable.
     */
    provider() {
        return this.handleFor().provider;
    }
    /**
     * Drop the cached backend after a configuration change.
     *
     * A change that lands while a query or write is in flight is deferred: the
     * backend is closed once the operation finishes instead of under it.
     */
    invalidate() {
        if (this.activeOperations > 0) {
            this.staleHandle = true;
            return;
        }
        this.dropHandle();
    }
    /** Close the backend and forget cached recall blocks. */
    dropHandle() {
        this.handle?.provider?.close?.();
        this.handle = undefined;
        this.recall.clear();
    }
    /** Mark the start of one backend operation. */
    beginWork() {
        this.activeOperations += 1;
    }
    /** Mark the end of one backend operation and apply a deferred invalidation. */
    endWork() {
        this.activeOperations -= 1;
        if (this.activeOperations <= 0 && this.staleHandle) {
            this.staleHandle = false;
            this.dropHandle();
        }
    }
    /**
     * Record the vector length the endpoint actually returns and keep the
     * configured dimension in step with it.
     * @param observed - length returned by the endpoint.
     * @param configured - length asked for by the configuration; `0` means "any".
     */
    observeEmbeddingDim(observed, configured) {
        if (!Number.isFinite(observed) || observed <= 0)
            return;
        this.observedDim = observed;
        if (configured === observed || this.dimSyncing)
            return;
        const settings = this.settings;
        const update = settings?.update;
        if (settings === undefined || update === undefined)
            return;
        this.dimSyncing = true;
        const timer = this.track(setTimeout(() => {
            void update.call(settings, MEMORY_NS, { embeddingDim: observed })
                .then(() => { this.warn(`embedding dimension synced to ${String(observed)}`); })
                .catch((error) => { this.warn(`failed to sync embedding dimension: ${String(error)}`); })
                .finally(() => { this.dimSyncing = false; });
        }, DIM_SYNC_DELAY_MS));
        timer.unref?.();
    }
    /**
     * Backend for the current configuration, reusing one instance per signature.
     * @returns the handle.
     */
    handleFor() {
        const config = this.config();
        if (this.handle !== undefined && this.handle.signature === providerSignature(config))
            return this.handle;
        this.handle?.provider?.close?.();
        this.handle = createProvider(config, {
            onDim: (observed, configured) => { this.observeEmbeddingDim(observed, configured); },
        });
        return this.handle;
    }
    /** The route-facing implementation. */
    api() {
        return {
            state: () => this.state(),
            search: async (input) => this.requireProvider().search({ text: input.text, topK: input.topK, fusion: this.config().fusion }),
            list: (input) => this.requireProvider().list(input),
            write: async (draft) => {
                const written = await this.requireProvider().write(draft);
                void this.refreshStanding();
                return written;
            },
            update: async (id, patch) => {
                await this.requireProvider().update(id, patch);
                void this.refreshStanding();
            },
            remove: async (id) => {
                await this.requireProvider().remove(id);
                void this.refreshStanding();
            },
            dedupe: async () => {
                const provider = this.requireProvider();
                if (provider.dedupe === undefined)
                    return { removed: 0 };
                const result = await provider.dedupe();
                void this.refreshStanding();
                return result;
            },
            reembed: async () => {
                const provider = this.requireProvider();
                if (provider.reembedAll === undefined)
                    return { updated: 0, failed: 0 };
                return provider.reembedAll();
            },
            saveConfig: async (patch) => {
                const update = this.settings?.update;
                if (update === undefined)
                    throw new Error('宿主设置服务不可用，无法保存记忆配置');
                await update.call(this.settings, MEMORY_NS, pickConfigPatch(patch));
            },
        };
    }
    /**
     * Reject calls that arrive while the feature is switched off.
     * @returns the backend.
     * @throws when no backend can serve the call.
     */
    requireProvider() {
        const provider = this.provider();
        if (provider === undefined)
            throw new Error(this.complaint() ?? '记忆功能不可用');
        return provider;
    }
    /**
     * Build the state payload for the settings card and toolbox page.
     * @returns configuration, reachability, and counters.
     */
    async state() {
        const config = this.config();
        const handle = this.handleFor();
        const payload = {
            config,
            diagnostics: { ...this.diagnostics, recall: this.recall.stats() },
            embedding: {
                configured: config.embeddingDim,
                ...(this.observedDim === undefined ? {} : { observed: this.observedDim }),
            },
            health: { ok: false, kind: 'none', detail: handle.complaint ?? '记忆功能不可用' },
            count: -1,
            ...(handle.complaint === undefined ? {} : { complaint: handle.complaint }),
            ...(config.mode === 'local' ? { database: resolveMemoryDb(config) } : {}),
        };
        if (handle.provider === undefined)
            return payload;
        const [health, count] = await Promise.all([
            handle.provider.health().catch((error) => ({
                ok: false,
                kind: handle.provider?.kind ?? 'local',
                detail: error instanceof Error ? error.message : String(error),
            })),
            handle.provider.count().catch(() => -1),
        ]);
        return { ...payload, health, count };
    }
    /**
     * Follow one session event: refresh recall on user input, schedule extraction
     * after the assistant settles.
     * @param session - emitting session.
     * @param event - committed event.
     */
    onSessionEvent(session, event) {
        const config = this.config();
        if (!config.enabled)
            return;
        const seq = Number(event.seq);
        if (!Number.isFinite(seq))
            return;
        this.diagnostics.events += 1;
        const state = this.sessionState(session.id);
        if (!state.initialized) {
            state.initialized = true;
            state.seenSeq = seq - 1;
        }
        const text = eventText(event);
        if (event.type === 'user/message') {
            state.recallSeq = seq;
            this.scheduleRecall(session.id, state, text);
            return;
        }
        if (event.type === 'assistant/message')
            this.scheduleExtraction(session, state);
    }
    /**
     * Poll live sessions.
     *
     * Session events are the fast path and this is the guarantee: it reads each
     * root agent's own log, so recall and extraction work even when the event
     * never reaches this context.
     */
    sweep() {
        const config = this.config();
        if (!config.enabled)
            return;
        this.diagnostics.sweeps += 1;
        if (this.standingAt === 0 || Date.now() - this.standingAt > STANDING_REFRESH_MS)
            void this.refreshStanding();
        const agents = this.agentRegistry;
        if (agents === undefined)
            return;
        const live = (agents.roots?.() ?? agents.list?.() ?? []);
        for (const agent of live) {
            const session = agent.session;
            if (session === undefined || typeof session.id !== 'string')
                continue;
            const events = session.snapshotEvents?.() ?? [];
            const last = events[events.length - 1];
            if (last === undefined)
                continue;
            const lastSeq = Number(last.seq);
            if (!Number.isFinite(lastSeq))
                continue;
            const state = this.sessionState(session.id);
            if (!state.initialized) {
                // First sight of a running session: keep its history out of extraction.
                state.initialized = true;
                state.seenSeq = lastSeq;
            }
            const lastUser = [...events].reverse().find((event) => event.type === 'user/message');
            if (lastUser !== undefined && Number(lastUser.seq) !== state.recallSeq) {
                state.recallSeq = Number(lastUser.seq);
                this.scheduleRecall(session.id, state, eventText(lastUser));
            }
            if (!config.autoExtract || state.timer !== undefined)
                continue;
            if (agent.status !== 'idle' || lastSeq <= state.seenSeq)
                continue;
            this.scheduleExtraction(session, state);
        }
    }
    /**
     * Rebuild the always-on block from the newest stable preferences.
     *
     * Runs without a query so it is ready before any conversation starts.
     */
    async refreshStanding() {
        const provider = this.provider();
        if (provider === undefined) {
            this.recall.setStanding([]);
            return;
        }
        this.beginWork();
        try {
            this.recall.setStanding(await provider.list({ limit: 50, offset: 0 }));
            this.standingAt = Date.now();
        }
        catch (error) {
            this.warn(`standing refresh failed: ${String(error)}`);
        }
        finally {
            this.endWork();
        }
    }
    /**
     * Refresh the recall block after a short quiet period.
     * @param sessionId - session identity.
     * @param state - session bookkeeping.
     * @param query - user text used as the query.
     */
    scheduleRecall(sessionId, state, query) {
        if (!this.config().autoRecall || query.trim() === '')
            return;
        if (state.recallTimer !== undefined)
            clearTimeout(state.recallTimer);
        state.recallTimer = this.track(setTimeout(() => {
            state.recallTimer = undefined;
            void this.refreshRecall(sessionId, query);
        }, RECALL_DEBOUNCE_MS));
    }
    /**
     * Search the backend for one session's current topic.
     * @param sessionId - session identity.
     * @param query - user text used as the query.
     */
    async refreshRecall(sessionId, query) {
        const provider = this.provider();
        if (provider === undefined)
            return;
        this.beginWork();
        try {
            const hits = await provider.search({ text: query, topK: this.config().recallTopK, fusion: this.config().fusion });
            this.recall.set(sessionId, hits);
        }
        catch (error) {
            this.warn(`recall search failed: ${String(error)}`);
        }
        finally {
            this.endWork();
        }
    }
    /**
     * Restart the extraction quiet timer for one session.
     * @param session - emitting session.
     * @param state - session bookkeeping.
     */
    scheduleExtraction(session, state) {
        if (!this.config().autoExtract)
            return;
        if (state.timer !== undefined)
            clearTimeout(state.timer);
        state.timer = this.track(setTimeout(() => {
            state.timer = undefined;
            void this.flushExtraction(session);
        }, EXTRACT_QUIET_MS));
    }
    /**
     * Extract and store facts from everything the session produced since the last pass.
     * @param session - session to read.
     */
    async flushExtraction(session) {
        const config = this.config();
        const provider = this.provider();
        if (provider === undefined || !config.autoExtract)
            return;
        const state = this.sessionState(session.id);
        const events = session.snapshotEvents?.() ?? [];
        const rules = extractionRules(config);
        const { lines, lastSeq } = collectTurnMessages(events, state.seenSeq, { source: rules.source });
        if (lines.length === 0)
            return;
        let transcript = lines;
        if (rules.mode === 'explicit') {
            const asked = hasExplicitRequest(lines.flatMap((line) => (line.role === 'user' ? [line.text] : [])), rules.keywords);
            // 仅明确要求模式：没说要记就整段跳过，并把序号推进到已看过，避免堆积。
            if (!asked) {
                state.seenSeq = lastSeq;
                return;
            }
            transcript = lines.slice(Math.max(0, lines.length - EXPLICIT_WINDOW_LINES));
        }
        const controller = new AbortController();
        let stored = 0;
        this.beginWork();
        try {
            const existing = await this.existingContents(provider, transcript);
            const drafts = await extractMemories({ transcript, existing, rules }, (input) => this.complete({ ...input, sessionId: session.id }, controller.signal), controller.signal);
            const workspace = typeof session.header?.cwd === 'string' ? session.header.cwd : undefined;
            for (const draft of drafts) {
                await provider.write({
                    ...draft,
                    sourceSession: session.id,
                    ...(workspace === undefined ? {} : { sourceWorkspace: workspace }),
                });
                stored += 1;
            }
            state.seenSeq = lastSeq;
            this.diagnostics.lastExtract = { at: Date.now(), ok: true, count: stored };
            if (stored > 0) {
                this.warn(`extracted ${String(stored)} memories from session ${session.id}`);
                void this.refreshStanding();
            }
        }
        catch (error) {
            state.seenSeq = lastSeq;
            const message = error instanceof Error ? error.message : String(error);
            this.diagnostics.lastExtract = { at: Date.now(), ok: false, count: 0, error: message };
            this.warn(`extraction failed: ${message}`);
        }
        finally {
            this.endWork();
        }
    }
    /**
     * Sample stored contents so the model can avoid duplicates.
     * @param provider - active backend.
     * @param lines - transcript of the turn.
     * @returns stored contents, most relevant first.
     */
    async existingContents(provider, lines) {
        const lastUser = [...lines].reverse().find((line) => line.role === 'user');
        if (lastUser === undefined)
            return [];
        try {
            const hits = await provider.search({ text: lastUser.text, topK: EXISTING_SAMPLE, fusion: 'rrf' });
            return hits.map((hit) => hit.content);
        }
        catch {
            return [];
        }
    }
    /**
     * Run one auxiliary completion through the host model service.
     * @param input - prompts and cancellation.
     * @param signal - cancellation signal.
     * @returns the model's text answer.
     */
    async complete(input, signal) {
        const llm = this.llm;
        if (llm?.stream === undefined)
            throw new Error('宿主未提供 llm 服务，无法自动提炼记忆');
        const route = this.route(llm);
        const assembler = new BlockAssembler();
        // `purpose` is a closed union (`compaction` | `session-title`), so an
        // auxiliary call of ours must leave it unset instead of inventing one.
        const options = {
            provider: route.provider,
            model: route.model,
            messages: [createUserMessage({
                    content: [{ type: 'text', text: input.user }],
                    source: { kind: 'plugin', plugin: 'dsh-sidebar' },
                })],
            system: input.system,
            maxTokens: EXTRACT_MAX_TOKENS,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            signal,
        };
        for await (const chunk of llm.stream(options))
            assembler.push(chunk);
        return assembler.blocks()
            .flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : []))
            .join('\n');
    }
    /**
     * Resolve the model route used for extraction.
     * @param llm - model service.
     * @returns provider and model ids.
     */
    route(llm) {
        const configured = this.config().extractModel;
        const read = this.settings?.get;
        const preferred = (read === undefined
            ? undefined
            : read.call(this.settings, 'agent-default-model'));
        const provider = typeof preferred?.provider === 'string' ? preferred.provider : '';
        const model = configured !== '' ? configured : typeof preferred?.model === 'string' ? preferred.model : '';
        if (provider !== '' && model !== '')
            return { provider, model };
        const first = llm.listProviders?.()[0];
        const fallbackModel = first?.models?.[0]?.id;
        if (first?.id !== undefined && fallbackModel !== undefined) {
            return { provider: provider === '' ? first.id : provider, model: model === '' ? fallbackModel : model };
        }
        throw new Error('无法确定用于提炼记忆的模型，请在「设置 → 模型」里配置默认模型');
    }
    /**
     * Session bookkeeping, created on first sight.
     * @param sessionId - session identity.
     * @returns the state record.
     */
    sessionState(sessionId) {
        const existing = this.sessions.get(sessionId);
        if (existing !== undefined)
            return existing;
        const created = { initialized: false, seenSeq: 0, recallSeq: 0 };
        this.sessions.set(sessionId, created);
        return created;
    }
    /**
     * Track a timer so unload clears it.
     * @param timer - timer handle.
     * @returns the same handle.
     */
    track(timer) {
        this.timers.add(timer);
        return timer;
    }
    /**
     * Log a warning through the host logger.
     * @param message - text to log.
     */
    warn(message) {
        this.ctx.logger?.warn(`dsh-sidebar memory: ${message}`);
    }
}
/**
 * Keep only known settings keys from a browser patch.
 * @param patch - raw patch.
 * @returns the sanitized patch.
 */
function pickConfigPatch(patch) {
    const allowed = new Set(MEMORY_CONFIG_KEYS);
    const cleaned = {};
    for (const [key, value] of Object.entries(patch)) {
        if (!allowed.has(key))
            continue;
        cleaned[key] = value;
    }
    return cleaned;
}
/**
 * Split a comma-separated settings field.
 * @param value - raw field value.
 * @returns the trimmed, non-empty items.
 */
function splitList(value) {
    return value.split(/[，,]/).map((item) => item.trim()).filter((item) => item !== '');
}
/**
 * Project the remembrance policy out of the configuration.
 * @param config - resolved configuration.
 * @returns the rules the pipeline applies.
 */
function extractionRules(config) {
    const keywords = splitList(config.extractKeywords);
    return {
        mode: config.extractMode,
        source: config.extractSource,
        kinds: splitList(config.extractKinds),
        focus: config.extractFocus,
        exclude: config.extractExclude,
        minConfidence: config.extractMinConfidence,
        maxFacts: config.extractMax,
        keywords: keywords.length === 0 ? DEFAULT_EXPLICIT_KEYWORDS : keywords,
    };
}
/**
 * Read the session id out of the prompt-assembly context, when it exposes one.
 * @param context - value handed to the context renderer.
 * @returns the session id, or `''`.
 */
function sessionIdOf(context) {
    const record = context;
    const candidate = record?.session?.id ?? record?.agent?.session?.id;
    return typeof candidate === 'string' ? candidate : '';
}
/**
 * Read the text of one session event.
 * @param event - committed event.
 * @returns the joined text, empty when the event carries none.
 */
function eventText(event) {
    const data = event.data;
    if (!Array.isArray(data?.content))
        return '';
    return data.content
        .flatMap((block) => {
        const record = block;
        return record.type === 'text' && typeof record.text === 'string' ? [record.text] : [];
    })
        .join('\n')
        .trim();
}
/**
 * Install the memory feature.
 * @param ctx - host context.
 * @param composition - plugin composition config.
 */
export function applyMemory(ctx, composition) {
    new MemoryRuntime(ctx, composition ?? {}).start();
}
