/**
 * Automatic memory extraction.
 *
 * A settled turn is summarized by the session model into JSON facts. Parsing
 * and transcript handling are pure; the model call arrives as a callback so the
 * pipeline is testable without a runtime.
 */
import { compactEntries, contentHash, isStorable, normalizeContent } from './retrieve.js';
/** Facts the model may emit. */
export const ALLOWED_KINDS = ['preference', 'fact', 'decision', 'entity', 'convention'];
/** Default trigger words for the explicit mode. */
export const DEFAULT_EXPLICIT_KEYWORDS = [
    '记住', '记一下', '记下', '记着', '牢记', '别忘了', '别忘记', '帮我记', '以后要',
    'remember', 'keep in mind', 'note that',
];
/** Rules in force when the settings section says nothing. */
export const DEFAULT_EXTRACTION_RULES = {
    mode: 'auto',
    source: 'user',
    kinds: [],
    focus: '',
    exclude: '',
    minConfidence: 0.7,
    maxFacts: 5,
    keywords: DEFAULT_EXPLICIT_KEYWORDS,
};
/** Transcript characters handed to the model. */
const TRANSCRIPT_BUDGET = 12_000;
/** Existing-content budget used to steer the model away from duplicates. */
const EXISTING_BUDGET = 2_000;
/**
 * Whether the user asked for something to be remembered.
 * @param texts - user utterances of the turn.
 * @param keywords - configured trigger words.
 * @returns `true` when one utterance carries a trigger.
 */
export function hasExplicitRequest(texts, keywords) {
    const active = keywords.map((word) => word.trim()).filter((word) => word !== '');
    if (active.length === 0)
        return false;
    return texts.some((text) => {
        const lowered = text.toLowerCase();
        return active.some((word) => lowered.includes(word.toLowerCase()));
    });
}
/**
 * Render a transcript for the prompt, keeping the most recent lines.
 * @param transcript - conversation lines.
 * @param budget - character budget.
 * @returns the rendered transcript, oldest first within the budget.
 */
export function renderTranscript(transcript, budget = TRANSCRIPT_BUDGET) {
    const lines = [];
    let used = 0;
    for (let index = transcript.length - 1; index >= 0; index -= 1) {
        const line = transcript[index];
        if (line === undefined)
            continue;
        const rendered = `${line.role === 'user' ? '用户' : '助手'}：${line.text}`;
        if (used + rendered.length > budget && lines.length > 0)
            break;
        used += rendered.length;
        lines.push(rendered);
    }
    return lines.reverse().join('\n');
}
/**
 * Build the extraction prompt pair.
 * @param request - transcript and known contents.
 * @returns the system and user prompts.
 */
export function extractionPrompts(request) {
    const rules = request.rules ?? DEFAULT_EXTRACTION_RULES;
    const kinds = rules.kinds.length === 0 ? [...ALLOWED_KINDS] : rules.kinds;
    const system = [
        '你是长期记忆提炼器。从对话片段中抽取值得跨会话记住的稳定信息。',
        '只输出一个 JSON 数组，不要输出解释、Markdown 或代码块围栏。',
        `数组元素形如：{"kind":"${kinds.join('|')}","content":"一句话事实","tags":["标签"],"confidence":0.9}`,
        '规则：',
        '1. 一条元素只写一个事实，用陈述句，语言与对话一致。',
        `2. 最多 ${String(rules.maxFacts)} 条；宁可少记也不要凑数，没有值得记住的内容时输出 []。`,
        `3. 只使用这些类型：${kinds.join('、')}。`,
        '4. 只记录对以后仍然成立的信息：用户明确表达的偏好或习惯、项目硬事实、已定决策、关键实体、达成的工作约定。',
        '5. 明确不要记录：寒暄与客套、临时状态或一次性操作细节、可以从代码或文件重新读到的内容、助手自己的说明或推测、对话过程本身（例如「用户问了一个问题」「助手回答了」）。',
        '6. 不要与「已有记忆」重复：同一事实换个说法、少个句号、多一个标签都属于重复，不要再输出。',
        '7. 不要凭空推测；只写对话里能直接支持的事实。',
        '8. 置信度要诚实：只有用户明确说出的给 0.8 以上，需要从上下文推断的一律低于 0.6。',
        rules.focus.trim() === '' ? '' : `额外要求（用户自定义，优先遵守）：${rules.focus.trim()}`,
        rules.exclude.trim() === '' ? '' : `额外排除（用户自定义，绝不记录）：${rules.exclude.trim()}`,
    ].filter((line) => line !== '').join('\n');
    const existing = request.existing
        .map((item) => normalizeContent(item))
        .join('\n')
        .slice(0, EXISTING_BUDGET);
    const user = [
        existing === '' ? '已有记忆：（空）' : `已有记忆：\n${existing}`,
        '对话片段：',
        renderTranscript(request.transcript),
    ].join('\n\n');
    return { system, user };
}
/**
 * Extract the first JSON array from a model answer.
 * @param raw - raw model text.
 * @returns the decoded array, or `[]` when none is found.
 */
function firstJsonArray(raw) {
    const withoutFences = raw.replace(/```[a-zA-Z]*\n?/g, '').trim();
    const start = withoutFences.indexOf('[');
    const end = withoutFences.lastIndexOf(']');
    if (start === -1 || end === -1 || end < start)
        return [];
    try {
        const parsed = JSON.parse(withoutFences.slice(start, end + 1));
        return Array.isArray(parsed) ? parsed : [];
    }
    catch {
        return [];
    }
}
/**
 * Turn a model answer into deduplicated, storable drafts.
 * @param raw - raw model text.
 * @param rules - kind filter, confidence floor, and cap in force.
 * @returns the accepted drafts, newest rule wins on duplicates.
 */
export function parseExtraction(raw, rules = DEFAULT_EXTRACTION_RULES) {
    const allowed = new Set(rules.kinds.length === 0 ? [...ALLOWED_KINDS] : rules.kinds);
    const seen = new Set();
    const drafts = [];
    for (const item of firstJsonArray(raw)) {
        const record = item;
        if (record === undefined || record === null)
            continue;
        const rawKind = typeof record.kind === 'string' ? record.kind.trim().toLowerCase() : '';
        const kind = ALLOWED_KINDS.includes(rawKind) ? rawKind : 'fact';
        if (!allowed.has(kind))
            continue;
        const content = typeof record.content === 'string' ? record.content : '';
        if (!isStorable(kind, content))
            continue;
        const tags = Array.isArray(record.tags)
            ? record.tags.map((tag) => String(tag).trim()).filter((tag) => tag !== '')
            : [];
        const confidence = Number(record.confidence);
        const value = Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.7;
        // The model is asked to score uncertain guesses below 0.6; the floor keeps
        // those out of the store entirely.
        if (value + 1e-9 < rules.minConfidence)
            continue;
        const hash = contentHash(content);
        if (seen.has(hash))
            continue;
        seen.add(hash);
        drafts.push({ kind, content: normalizeContent(content), tags, confidence: value });
    }
    return compactEntries(drafts).slice(0, rules.maxFacts);
}
/**
 * Run one extraction pass.
 * @param request - transcript and existing contents.
 * @param complete - model call.
 * @param signal - cancellation signal.
 * @returns accepted drafts, empty when the model found nothing or failed.
 */
export async function extractMemories(request, complete, signal) {
    if (request.transcript.length === 0)
        return [];
    const rules = request.rules ?? DEFAULT_EXTRACTION_RULES;
    const prompts = extractionPrompts(request);
    try {
        const raw = await complete({ system: prompts.system, user: prompts.user, signal });
        return parseExtraction(raw, rules);
    }
    catch (error) {
        if (signal.aborted)
            return [];
        throw error;
    }
}
/**
 * Collect the turn's conversation lines from session events.
 * @param events - session event log, oldest first.
 * @param sinceSeq - only events after this sequence are read.
 * @param options - line cap (newest kept) and which speakers to read.
 * @returns the lines and the highest sequence observed.
 */
export function collectTurnMessages(events, sinceSeq, options = {}) {
    const maxLines = options.maxLines ?? 60;
    const lines = [];
    let lastSeq = sinceSeq;
    for (const event of events) {
        if (event.seq <= sinceSeq)
            continue;
        if (event.seq > lastSeq)
            lastSeq = event.seq;
        const role = event.type === 'user/message'
            ? 'user'
            : event.type === 'assistant/message' ? 'assistant' : undefined;
        if (role === undefined)
            continue;
        // Facts usually come from the person speaking; assistant text is opt-in
        // because it is where speculation and meta-statements creep in.
        if (role === 'assistant' && options.source === 'user')
            continue;
        const text = messageText(event);
        if (text === '')
            continue;
        lines.push({ role, text });
    }
    return { lines: lines.slice(Math.max(0, lines.length - maxLines)), lastSeq };
}
/**
 * Read the text of one message event.
 * @param event - session event.
 * @returns the joined text, empty when the event carries none.
 */
function messageText(event) {
    const data = event.data;
    const blocks = Array.isArray(data?.content)
        ? data.content
        : Array.isArray(data?.message?.content) ? data.message.content : [];
    const parts = [];
    for (const block of blocks) {
        const text = block;
        if (text?.type !== 'text' || typeof text.text !== 'string')
            continue;
        parts.push(text.text);
    }
    return parts.join('\n').trim();
}
