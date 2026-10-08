/**
 * 团队级成本汇总数据层（DESIGN C.1；2026-10-08 评审裁决：数据层与展示层分离，
 * UI 全部在步 7 按 D.5 落地）。
 *
 * ## 问题
 *
 * 每个成员是**独立会话**（`startContinuable` 创建），`dsh-cost-meter` 按会话算，
 * 面板上看不到「这个团一共花了多少、谁最贵」。本模块把成员会话的 usage/成本
 * 聚合成团队合计 + 成员分列，只做字段与 no-data 状态，不做 UI。
 *
 * ## 来源优先级（DESIGN C.1 定稿）
 *
 * 1. **dsh-cost-meter 服务**：`ctx.get('costMeter')`（实读
 *    `dsh-cost-meter@1.8.15` `lib/index.js` L3326 的 `ctx.provide('costMeter', …)`），
 *    最小方法集 `getSessionCost(sessionId)` → `{ found, own, subagents, subagentCount }`，
 *    桶字段为 `input/output/cacheRead/cacheWrite/reasoning/calls/cost/apiCost`
 *    （账本行回放自 provider usage 事件，父子会话分别入账）。
 * 2. **会话 usage 投影**：`ctx.get('sessionProjections')` 的 `snapshot(session, keys)`
 *    （实读宿主 `SessionProjectionRegistry`，键序）：
 *    - `costUsage`（dsh-cost-meter 自己注册的投影，`lib/index.js` L3321-3322，
 *      视图含 `input/output/cacheRead/cacheWrite/reasoning/cost` + `byModel`）；
 *    - `tokenUsage`（dsh-token-meter 注册的投影，**provider-reported** token 合计
 *      `{uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}`，
 *      **没有 cost** —— 绝不从 token 估算费用，费用桶保持缺席）。
 *
 * ## 硬纪律（DESIGN D.6 第 1 条 + 本步验收）
 *
 * - **探测一律 `ctx.get()`**（照 `router.ts` 的 `valueRouterOf()` 与
 *   `agency-bridge.ts` 的 `agencyServicesOf()` 模式）：模块级 `inject` 是硬依赖，
 *   服务缺席会让本插件整体不激活——`export const inject` 数组保持不动。
 *   **不用 try/catch 当探测器**；本模块允许的 catch 全部是**调用期失败隔离**
 *   （来源已在线、单次会话读数失败只让该成员缺数据，不能炸掉整个团队快照），
 *   每处注明原因。
 * - **无数据 ≠ 零**：来源缺席、成员没有会话、会话不在账本（`found === false`）、
 *   会话未附加（投影路径拿不到 live Session）、字段形状不认识——都输出
 *   no-data 状态，**绝不输出 0 充数、绝不估算**。0 只有在来源明确报告 0 时
 *   才是真实读数（会话在账本但用量为零）。
 * - **每个数字标注来源**：闭集 `TeamCostSource`（服务/投影名），由
 *   `scripts/cost-aggregation.test.mjs` 断言。
 * - **全部纯函数式形状**：服务句柄与返回值以 `unknown` 承接并自行校验形状，
 *   跨版本字段漂移被 guard 吸收为 no-data，而不是把类型错误炸进编译产物。
 * - **不写 team.json**：成本是活数据；唯一入口 `assembleTeamCost()` 供快照装配层调用。
 *
 * @module dsh-agent-teams/cost
 */
/** dsh-cost-meter 注册的 Cordis 服务键（实读其 `lib/index.js` L3326）。 */
export const COST_METER_SERVICE_KEY = 'costMeter';
/** 宿主 session-projection seam 的服务键（`SessionProjectionRegistry` 构造器注册名）。 */
export const SESSION_PROJECTIONS_SERVICE_KEY = 'sessionProjections';
/** dsh-cost-meter 注册的会话投影键（视图含 cost 桶）。 */
export const COST_USAGE_PROJECTION_KEY = 'costUsage';
/** dsh-token-meter 注册的会话投影键（provider-reported token 合计，无 cost 桶）。 */
export const TOKEN_USAGE_PROJECTION_KEY = 'tokenUsage';
/**
 * 成本来源探测：`ctx.get()` 逐键探测（缺席即回落到下一优先级），最小方法集
 * 校验照 `agencyServicesOf()`。**永不抛错，不用 try/catch**——cordis 对缺席
 * 服务返回 `undefined`，`get` 本身不抛。
 *
 * 优先级：`costMeter` 服务（账本，跨重启的历史+`found` 权威标记）→
 * `sessionProjections` seam（live 折影，`costUsage` 优先于 `tokenUsage`，
 * 优先级在逐成员读数时落实）。
 */
export function costSourceOf(ctx) {
    if (ctx?.get === undefined) {
        return { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] };
    }
    const costMeter = ctx.get(COST_METER_SERVICE_KEY);
    if (isRecord(costMeter) && typeof costMeter['getSessionCost'] === 'function') {
        return {
            available: true,
            kind: 'cost-meter:service',
            getSessionCost: costMeter['getSessionCost'],
        };
    }
    const seam = ctx.get(SESSION_PROJECTIONS_SERVICE_KEY);
    if (isRecord(seam) && typeof seam['snapshot'] === 'function') {
        const agents = ctx.agents;
        return {
            available: true,
            kind: 'projection-seam',
            snapshot: seam['snapshot'],
            getAgent: (id) => {
                const agent = agents?.get?.(id);
                return isRecord(agent) ? agent : undefined;
            },
        };
    }
    return { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] };
}
/**
 * Restore the SessionId brand on a value that round-tripped through the
 * durable team file. The brand is erased by JSON serialization; the value
 * originated from `startContinuable`/`agent.id`, so this cast is the boundary
 * restoration, not a new assertion.
 */
function brandedSessionId(value) {
    return value;
}
/** Whether a parsed value is a plain record. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Whether a value is a non-negative finite number (the only valid reading). */
function isNonNegativeFinite(value) {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
/**
 * 收敛 cost-meter 的单会话返回值。`found !== true`（会话不在账本）或 `own`
 * 形状不认识 → `undefined`（该成员 no-data，绝不把空桶当读数）。
 */
function coerceSessionCost(raw) {
    if (!isRecord(raw) || raw['found'] !== true)
        return undefined;
    const own = isRecord(raw['own']) ? raw['own'] : undefined;
    if (own === undefined)
        return undefined;
    const count = raw['subagentCount'];
    const subagentCount = isNonNegativeFinite(count) && count > 0 ? Math.floor(count) : 0;
    const subsessions = subagentCount > 0 && isRecord(raw['subagents']) ? raw['subagents'] : undefined;
    return {
        own,
        ...(subsessions !== undefined ? { subsessions, subsessionCount: subagentCount } : { subsessionCount: 0 }),
    };
}
/** cost-meter 账本桶 → 契约桶（input/output/cacheRead/cacheWrite/cost；reasoning/calls 不在契约内，不透传）。 */
function bucketsFromCostMeter(buckets) {
    const metric = (key, target) => {
        const value = buckets[key];
        if (!isNonNegativeFinite(value))
            return {};
        return { [target]: { value, source: 'cost-meter:service' } };
    };
    return {
        ...metric('input', 'inputTokens'),
        ...metric('output', 'outputTokens'),
        ...metric('cacheRead', 'cacheReadTokens'),
        ...metric('cacheWrite', 'cacheWriteTokens'),
        // cost-meter 的 cost 桶是它的头部费用口径（订阅分摊计入；apiCost 为纯 API 价）。
        ...metric('cost', 'costEstimate'),
    };
}
/** `costUsage` 投影视图 → 契约桶（schema 同源：input/output/cacheRead/cacheWrite/cost）。 */
function bucketsFromCostUsage(view) {
    const metric = (key, target) => {
        const value = view[key];
        if (!isNonNegativeFinite(value))
            return {};
        return { [target]: { value, source: 'projection:costUsage' } };
    };
    return {
        ...metric('input', 'inputTokens'),
        ...metric('output', 'outputTokens'),
        ...metric('cacheRead', 'cacheReadTokens'),
        ...metric('cacheWrite', 'cacheWriteTokens'),
        ...metric('cost', 'costEstimate'),
    };
}
/**
 * `tokenUsage` 投影视图 → 契约桶。**provider-reported** token 合计；没有 cost
 * —— 费用桶保持缺席（DESIGN C.1「不估算」：绝不从 token 反推费用）。
 */
function bucketsFromTokenUsage(view) {
    const metric = (key, target) => {
        const value = view[key];
        if (!isNonNegativeFinite(value))
            return {};
        return { [target]: { value, source: 'projection:tokenUsage' } };
    };
    return {
        // token-meter 的 uncachedInputTokens 即 provider usage 的 inputTokens 原值。
        ...metric('uncachedInputTokens', 'inputTokens'),
        ...metric('outputTokens', 'outputTokens'),
        ...metric('cacheReadTokens', 'cacheReadTokens'),
        ...metric('cacheWriteTokens', 'cacheWriteTokens'),
    };
}
/** 逐桶求和（只合并来源真正报出的桶）；合计桶的来源取首个贡献者的来源。 */
function sumBuckets(readings) {
    const totals = {};
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costEstimate']) {
        let value = 0;
        let source;
        for (const reading of readings) {
            const metric = reading[key];
            if (metric === undefined)
                continue;
            value += metric.value;
            source ??= metric.source;
        }
        if (source !== undefined)
            totals[key] = { value, source };
    }
    return totals;
}
function hasAnyBucket(buckets) {
    return Object.values(buckets).some((metric) => metric !== undefined);
}
/** 一个成员的成本行骨架（无读数 = `reading` 缺席，≠ 0）。 */
function memberRow(member) {
    return { memberId: member.id, memberName: member.name };
}
/** cost-meter 路径读一个成员（async：服务调用）。 */
async function readMemberViaCostMeter(service, member) {
    const row = memberRow(member);
    if (member.id === '')
        return row;
    let raw;
    try {
        raw = await service(member.id);
    }
    catch (error) {
        // 允许的 catch（调用期失败隔离，不是探测）：来源已通过 ctx.get 在线探测，
        // 单次会话读数失败只让该成员缺数据，不能炸掉整个团队快照。
        return row;
    }
    const reading = coerceSessionCost(raw);
    if (reading === undefined)
        return row;
    const own = bucketsFromCostMeter(reading.own);
    const subsessions = reading.subsessions !== undefined ? bucketsFromCostMeter(reading.subsessions) : undefined;
    const merged = sumBuckets(subsessions !== undefined ? [own, subsessions] : [own]);
    if (!hasAnyBucket(merged))
        return row;
    return {
        ...row,
        reading: merged,
        ...(reading.subsessionCount > 0 ? { attributedSubsessions: reading.subsessionCount } : {}),
    };
}
/** 投影路径读一个成员（同步：seam 的 snapshot() 是同步读）。 */
function readMemberViaProjections(handle, member) {
    const row = memberRow(member);
    if (member.id === '')
        return row;
    const agent = handle.getAgent(brandedSessionId(member.id));
    const session = agent?.session;
    if (session === undefined || session === null)
        return row;
    let raw;
    try {
        raw = handle.snapshot(session, [COST_USAGE_PROJECTION_KEY, TOKEN_USAGE_PROJECTION_KEY]);
    }
    catch (error) {
        // 允许的 catch（调用期失败隔离，不是探测）：seam 已通过 ctx.get 在线探测，
        // 单会话投影折叠失败只让该成员缺数据，不能炸掉整个团队快照。
        return row;
    }
    const values = isRecord(raw) && isRecord(raw['values']) ? raw['values'] : undefined;
    if (values === undefined)
        return row;
    // costUsage 优先（含 cost 桶），tokenUsage 兜底（provider-reported token，无 cost）。
    const costUsage = isRecord(values[COST_USAGE_PROJECTION_KEY]) ? values[COST_USAGE_PROJECTION_KEY] : undefined;
    if (costUsage !== undefined) {
        const buckets = bucketsFromCostUsage(costUsage);
        if (hasAnyBucket(buckets))
            return { ...row, reading: buckets };
    }
    const tokenUsage = isRecord(values[TOKEN_USAGE_PROJECTION_KEY]) ? values[TOKEN_USAGE_PROJECTION_KEY] : undefined;
    if (tokenUsage !== undefined) {
        const buckets = bucketsFromTokenUsage(tokenUsage);
        if (hasAnyBucket(buckets))
            return { ...row, reading: buckets };
    }
    return row;
}
/**
 * 聚合一个团队的成本汇总：团队合计 + 成员分列，每个数字标注来源。
 *
 * - 来源缺席 / 花名册为空 / 任何成员都读不到 → `status: 'no-data'` + 原因，
 *   **没有 totals、没有 members、没有任何数字**（≠ 0）。
 * - 至少一条读数 → `status: 'ok'`；`members` 为花名册全员（无读数的成员不带
 *   `reading`），`totals` 只对成员真正报出的桶求和。
 *
 * 永不抛错；不写任何状态文件。
 */
export async function assembleTeamCost(ctx, members) {
    const source = costSourceOf(ctx);
    if (!source.available) {
        return {
            status: 'no-data',
            reason: `成本来源缺席：${source.missing.join(', ')} 服务未注册（dsh-cost-meter 未安装或未启用，宿主无会话投影 seam）`,
        };
    }
    if (members.length === 0) {
        return { status: 'no-data', reason: '团队还没有成员会话，无成本可汇总' };
    }
    const rows = source.kind === 'cost-meter:service'
        ? await Promise.all(members.map((member) => readMemberViaCostMeter(source.getSessionCost, member)))
        : members.map((member) => readMemberViaProjections(source, member));
    const readings = rows
        .map((row) => row.reading)
        .filter((reading) => reading !== undefined);
    if (readings.length === 0) {
        return {
            status: 'no-data',
            reason: source.kind === 'cost-meter:service'
                ? 'cost-meter 账本没有这些成员会话的记录（成员尚未产生用量，或账本未覆盖这些会话）'
                : '成员会话未附加或投影视图不可读（costUsage/tokenUsage 均无有效数据）',
        };
    }
    return {
        status: 'ok',
        // 全员同源（同一来源路径）；合计桶的来源取首个贡献者。
        source: firstSource(readings),
        totals: sumBuckets(readings),
        members: rows,
    };
}
/** 读数里首个桶的来源（同一读数内全部桶同源，由构造保证；空读数组回落服务来源）。 */
function firstSource(readings) {
    for (const buckets of readings) {
        for (const metric of Object.values(buckets)) {
            if (metric !== undefined)
                return metric.source;
        }
    }
    return 'cost-meter:service';
}
// ── 快照边界 guard（形状校验；`scripts/cost-aggregation.test.mjs` 断言） ──
/** 校验来源闭集。 */
export function isTeamCostSource(value) {
    return value === 'cost-meter:service'
        || value === 'projection:costUsage'
        || value === 'projection:tokenUsage';
}
/** 校验一个实测数字：非负有限数值 + 闭集来源。 */
export function isTeamCostMetric(value) {
    return isRecord(value)
        && isNonNegativeFinite(value['value'])
        && isTeamCostSource(value['source']);
}
/** 校验契约桶：出现的桶必须各自合法（缺桶合法 = 无数据）。 */
export function isTeamCostBuckets(value) {
    if (!isRecord(value))
        return false;
    return ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costEstimate']
        .every((key) => value[key] === undefined || isTeamCostMetric(value[key]));
}
/** 校验一个成员成本行。 */
export function isTeamMemberCost(value) {
    if (!isRecord(value))
        return false;
    return typeof value['memberId'] === 'string'
        && typeof value['memberName'] === 'string'
        && (value['reading'] === undefined || isTeamCostBuckets(value['reading']))
        && (value['attributedSubsessions'] === undefined
            || (isNonNegativeFinite(value['attributedSubsessions']) && Number.isInteger(value['attributedSubsessions'])));
}
/** 校验团队成本汇总（快照边界 guard；形状回归时调用方整段省略而非发给坏形状）。 */
export function isTeamCostSummary(value) {
    if (!isRecord(value))
        return false;
    if (value['status'] !== 'ok' && value['status'] !== 'no-data')
        return false;
    if (value['source'] !== undefined && !isTeamCostSource(value['source']))
        return false;
    if (value['reason'] !== undefined && typeof value['reason'] !== 'string')
        return false;
    if (value['totals'] !== undefined && !isTeamCostBuckets(value['totals']))
        return false;
    if (value['members'] !== undefined
        && (!Array.isArray(value['members']) || !value['members'].every((row) => isTeamMemberCost(row))))
        return false;
    return true;
}
