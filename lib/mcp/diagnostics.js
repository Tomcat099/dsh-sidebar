/**
 * Translation layer from probe facts to something a user can act on.
 *
 * A probe returns a `kind` and a sentence; this module decides which of the
 * eight connection states that implies, which failure stage it belongs to, and
 * what the user should try next.
 *
 * The governing rule is that an unobserved entry never reads as healthy. A
 * stdio server the Host has not confirmed, an entry nobody has checked yet, and
 * an entry whose credentials are missing all resolve to `unknown` or `reauth` —
 * never to a green dot.
 */
import { displayName, endpointLabel } from './schema.js';
/** Chinese label for each connection state. */
export const CONNECTION_STATE_LABELS = Object.freeze({
    disconnected: '未配置',
    unknown: '状态未知',
    disabled: '已停用',
    healthy: '已连接',
    degraded: '部分异常',
    reauth: '需重新授权',
    recovering: '自动重试中',
    unavailable: '连接异常',
});
/** Chinese label for each failure stage. */
export const STAGE_LABELS = Object.freeze({
    configuration: '配置',
    authentication: '鉴权',
    transport: '网络与传输',
    'mcp-initialize': 'MCP 初始化',
    'host-startup': 'Host 启动',
    'host-observation': 'Host 状态观测',
    'tool-discovery': '工具发现',
    ready: '可用性确认',
});
/**
 * Failure code to `[stage, suggested action]`.
 *
 * The action is the sentence the UI shows under a failed row, so it must read
 * as an instruction rather than a restatement of the error.
 */
export const FAILURE_GUIDANCE = Object.freeze({
    // Configuration
    configuration: ['configuration', '修正这一条的必填字段后重新保存'],
    // Authentication
    auth: ['authentication', '更新 token，或检查 ~/.dsh/.env 里对应的变量是否仍是有效值'],
    'authorization-required': ['authentication', '把 token 写入 ~/.dsh/.env，并在这里填写那个环境变量名'],
    // Transport
    'rate-limit': ['transport', '等待服务端限流窗口过去，稍后会自动重试'],
    dns: ['transport', '检查域名拼写、DNS 设置与代理配置'],
    tls: ['transport', '检查证书是否过期、是否需要 VPN，或来源 IP 是否在白名单里'],
    refused: ['transport', '确认 URL 与端口是否正确、目标服务是否在运行'],
    timeout: ['transport', '检查网络与目标服务状态，必要时确认该服务是否响应较慢'],
    http: ['transport', '检查 URL、服务状态与访问策略'],
    network: ['transport', '检查网络连通性与 URL 是否正确'],
    // MCP initialize
    protocol: ['mcp-initialize', '确认这个 URL 指向兼容的 MCP Streamable HTTP 端点'],
    // Host startup
    startup: ['host-startup', '查看 Host 日志，确认启动命令、参数与环境变量'],
    'process-not-found': ['host-startup', '安装缺失的运行时，或修正 command 的路径'],
    'process-exit': ['host-startup', '查看该进程的退出码、参数、环境变量与日志'],
    // Host observation
    'host-tools-pending': ['host-observation', '稍后再检查一次；在确认可用之前这里会保持「状态未知」'],
    'host-status-unavailable': ['host-observation', '当前 DSH 无法汇报工具注册状态，重启 Host 后再试'],
    'host-status-error': ['host-observation', '查看 Host 日志后重新检查注册状态'],
    managed: ['host-observation', '本地进程由 DSH 启动，可用性以新会话中是否出现工具为准'],
    // Tool discovery
    'tool-list': ['tool-discovery', '检查这个 Server 的工具权限与服务端状态'],
});
/** Fallback guidance for a code with no table entry. */
const FALLBACK_GUIDANCE = ['transport', '检查网络与 MCP URL 是否正确'];
/**
 * Resolve the failure stage for a probe outcome.
 * @param kind - outcome class from the probe.
 * @returns the pipeline stage it belongs to.
 */
export function stageOf(kind) {
    if (kind === 'connected')
        return 'ready';
    if (kind === 'managed')
        return 'host-observation';
    if (kind === 'authorization-required' || kind === 'auth')
        return 'authentication';
    if (kind === 'protocol')
        return 'mcp-initialize';
    if (kind === 'process-not-found' || kind === 'process-exit' || kind === 'startup')
        return 'host-startup';
    if (kind.startsWith('host-'))
        return 'host-observation';
    if (kind === 'tool-list')
        return 'tool-discovery';
    return 'transport';
}
/**
 * Resolve the connection state a failure implies.
 * @param kind - outcome class from the probe.
 * @returns `reauth` for credential failures, `recovering` for throttling, and
 * `unavailable` for everything else that failed.
 */
export function stateOfFailure(kind) {
    if (kind === 'auth' || kind === 'authorization-required')
        return 'reauth';
    if (kind === 'rate-limit')
        return 'recovering';
    if (kind === 'managed')
        return 'unknown';
    return 'unavailable';
}
/**
 * Build the diagnostic for one probe result.
 * @param result - outcome from {@link probeEntry}.
 * @param lastSuccessfulAt - previous success timestamp, when any.
 * @returns the diagnostic the UI renders.
 */
export function diagnosticFor(result, lastSuccessfulAt) {
    const kind = result.kind;
    const stage = stageOf(kind);
    const code = kind === 'connected' ? 'connected' : kind;
    if (result.ok) {
        return {
            state: 'healthy',
            stage,
            stageLabel: STAGE_LABELS[stage],
            code,
            message: result.message,
            action: '直接在新会话里使用它的工具',
            checkedAt: result.checkedAt,
            lastSuccessfulAt: result.checkedAt,
        };
    }
    const guidance = FAILURE_GUIDANCE[kind] ?? FALLBACK_GUIDANCE;
    return {
        state: stateOfFailure(kind),
        stage: guidance[0],
        stageLabel: STAGE_LABELS[guidance[0]],
        code,
        message: result.message,
        action: guidance[1],
        checkedAt: result.checkedAt,
        lastSuccessfulAt,
    };
}
/**
 * Build the diagnostic shown when a saved entry has not been observed yet.
 * @param checkedAt - when the placeholder was produced.
 * @param lastSuccessfulAt - previous success timestamp, when any.
 * @returns a diagnostic that reports `unknown` rather than guessing.
 */
export function unobservedDiagnostic(checkedAt, lastSuccessfulAt) {
    return {
        state: 'unknown',
        stage: 'host-observation',
        stageLabel: STAGE_LABELS['host-observation'],
        code: 'not-checked',
        message: '已有保存的配置，但本进程还没有观察到可用性检查结果',
        action: '点「检测连接」确认它现在能不能用',
        checkedAt,
        lastSuccessfulAt,
    };
}
/**
 * Build the diagnostic for an entry that is configured but switched off.
 * @param checkedAt - when the verdict was produced.
 * @returns a diagnostic reporting `disabled`.
 */
export function disabledDiagnostic(checkedAt) {
    return {
        state: 'disabled',
        stage: 'configuration',
        stageLabel: STAGE_LABELS.configuration,
        code: 'disabled',
        message: '这一条已停用，不会被挂载',
        action: '需要时打开开关，它会立即挂载',
        checkedAt,
    };
}
/**
 * Turn one probe result into the row the settings page shows.
 * @param server - entry the result describes, with its scope.
 * @param result - outcome of the probe.
 * @param extras - retry bookkeeping the health store owns.
 * @returns the health row.
 */
export function healthRow(server, result, extras = {}) {
    const diagnostic = diagnosticFor(result, extras.lastSuccessfulAt);
    const row = {
        ...diagnostic,
        id: server.id,
        name: displayName(server),
        // The per-row label: without it every row renders `undefined` where its
        // state should be, which is how it read before this was added.
        label: CONNECTION_STATE_LABELS[diagnostic.state],
        scope: server.scope,
        transport: server.transport,
        enabled: server.enabled,
        endpoint: endpointLabel(server),
        ok: result.ok,
    };
    if (result.tools !== undefined)
        row.toolCount = result.tools.length;
    if (extras.retryAt !== undefined)
        row.retryAt = extras.retryAt;
    if (extras.paused === true)
        row.paused = true;
    if (result.protocolVersion !== undefined)
        row.protocolVersion = result.protocolVersion;
    if (result.serverInfo?.name !== undefined)
        row.serverName = result.serverInfo.name;
    if (result.serverInfo?.version !== undefined)
        row.serverVersion = result.serverInfo.version;
    return row;
}
/**
 * Aggregate per-entry rows into the summary shown above the list.
 *
 * The ordering of the checks is the contract: a working subset with failures
 * reads as `degraded`, never as `healthy`.
 * @param rows - one row per configured server.
 * @param checkedAt - when the summary was produced.
 * @returns the summary.
 */
export function summarize(rows, checkedAt = new Date().toISOString()) {
    const configured = rows.length;
    const enabled = rows.filter(row => row.enabled).length;
    const available = rows.filter(row => row.ok).length;
    const pending = rows.filter(row => row.enabled && row.state === 'unknown').length;
    // "Unobserved" is not "failed": counting it here would turn every entry the
    // Host cannot report on into a red summary.
    const failed = rows.filter(row => row.enabled && !row.ok && row.state !== 'unknown').length;
    const authFailures = rows.filter(row => row.state === 'reauth').length;
    const recovering = rows.filter(row => row.state === 'recovering').length;
    const successes = rows
        .map(row => row.lastSuccessfulAt)
        .filter((value) => value !== undefined)
        .sort();
    const lastSuccessfulAt = successes.length === 0 ? undefined : successes[successes.length - 1];
    let connectionState;
    if (configured === 0)
        connectionState = 'disconnected';
    else if (enabled === 0)
        connectionState = 'disabled';
    else if (failed === 0 && pending === 0 && available > 0)
        connectionState = 'healthy';
    else if (available > 0 && (failed > 0 || pending > 0))
        connectionState = 'degraded';
    else if (pending > 0 && failed === 0)
        connectionState = 'unknown';
    else if (authFailures > 0)
        connectionState = 'reauth';
    else if (recovering > 0)
        connectionState = 'recovering';
    else
        connectionState = 'unavailable';
    const summary = {
        connectionState,
        label: CONNECTION_STATE_LABELS[connectionState],
        configured,
        enabled,
        available,
        pending,
        failed,
        authFailures,
        checkedAt,
        diagnostic: overallDiagnostic(rows, connectionState, checkedAt, lastSuccessfulAt),
        results: [...rows],
    };
    if (lastSuccessfulAt !== undefined)
        summary.lastSuccessfulAt = lastSuccessfulAt;
    return summary;
}
/**
 * Choose the diagnostic that best explains the overall state.
 * @param rows - per-entry rows.
 * @param connectionState - state the summary resolved to.
 * @param checkedAt - when the summary was produced.
 * @param lastSuccessfulAt - most recent success across entries.
 * @returns the summary-level diagnostic.
 */
function overallDiagnostic(rows, connectionState, checkedAt, lastSuccessfulAt) {
    if (rows.length === 0) {
        return {
            state: 'disconnected',
            stage: 'configuration',
            stageLabel: STAGE_LABELS.configuration,
            code: 'not-configured',
            message: '还没有配置 MCP 服务器',
            action: '点右上角「+ 添加」新建一条',
            checkedAt,
        };
    }
    if (connectionState === 'disabled')
        return disabledDiagnostic(checkedAt);
    if (connectionState === 'unknown')
        return unobservedDiagnostic(checkedAt, lastSuccessfulAt);
    const failing = rows.find(row => !row.ok && row.enabled && row.state !== 'unknown');
    const source = failing ?? rows.find(row => row.state === 'unknown') ?? rows[0];
    return {
        state: connectionState,
        stage: source.stage,
        stageLabel: source.stageLabel,
        code: source.code,
        message: source.message,
        action: source.action,
        checkedAt,
        lastSuccessfulAt,
    };
}
