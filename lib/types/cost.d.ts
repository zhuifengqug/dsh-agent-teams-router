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
import type { SessionId } from '@deepseek-ai/dsh-session';
import type { TeamCostBuckets, TeamCostMetric, TeamCostSource, TeamCostSummary, TeamMember, TeamMemberCost } from './types.ts';
/** dsh-cost-meter 注册的 Cordis 服务键（实读其 `lib/index.js` L3326）。 */
export declare const COST_METER_SERVICE_KEY = "costMeter";
/** 宿主 session-projection seam 的服务键（`SessionProjectionRegistry` 构造器注册名）。 */
export declare const SESSION_PROJECTIONS_SERVICE_KEY = "sessionProjections";
/** dsh-cost-meter 注册的会话投影键（视图含 cost 桶）。 */
export declare const COST_USAGE_PROJECTION_KEY = "costUsage";
/** dsh-token-meter 注册的会话投影键（provider-reported token 合计，无 cost 桶）。 */
export declare const TOKEN_USAGE_PROJECTION_KEY = "tokenUsage";
/** 本模块触碰的 ctx 结构面（照 agency-bridge 的最小结构类型，便于 stub 单测）。 */
export interface CostContextLike {
    get?(key: never): unknown;
    agents?: {
        get?(id: never): unknown;
    };
    logger?: {
        warn?(message: string): void;
    };
}
/** dsh-cost-meter 服务句柄（最小方法集已校验）。 */
export interface CostMeterServiceHandle {
    available: true;
    kind: 'cost-meter:service';
    getSessionCost: (sessionId: string) => Promise<unknown>;
}
/** 会话投影 seam 句柄（最小方法集已校验；`getAgent` 供 live 会话定位）。 */
export interface ProjectionSeamHandle {
    available: true;
    kind: 'projection-seam';
    snapshot: (session: unknown, keys: readonly string[]) => unknown;
    /** 按成员 durable 会话 id 取 live Agent（会话未附加时返回 undefined）。 */
    getAgent: (id: SessionId) => {
        session?: unknown;
    } | undefined;
}
/** 探测结果：服务 / 投影 seam / 全缺席。 */
export type CostSourceHandle = CostMeterServiceHandle | ProjectionSeamHandle | CostSourceAbsent;
export interface CostSourceAbsent {
    available: false;
    /** 探测过且都缺席的服务键。 */
    missing: readonly string[];
}
/**
 * 成本来源探测：`ctx.get()` 逐键探测（缺席即回落到下一优先级），最小方法集
 * 校验照 `agencyServicesOf()`。**永不抛错，不用 try/catch**——cordis 对缺席
 * 服务返回 `undefined`，`get` 本身不抛。
 *
 * 优先级：`costMeter` 服务（账本，跨重启的历史+`found` 权威标记）→
 * `sessionProjections` seam（live 折影，`costUsage` 优先于 `tokenUsage`，
 * 优先级在逐成员读数时落实）。
 */
export declare function costSourceOf(ctx: CostContextLike | undefined): CostSourceHandle;
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
export declare function assembleTeamCost(ctx: CostContextLike | undefined, members: readonly TeamMember[]): Promise<TeamCostSummary>;
/** 校验来源闭集。 */
export declare function isTeamCostSource(value: unknown): value is TeamCostSource;
/** 校验一个实测数字：非负有限数值 + 闭集来源。 */
export declare function isTeamCostMetric(value: unknown): value is TeamCostMetric;
/** 校验契约桶：出现的桶必须各自合法（缺桶合法 = 无数据）。 */
export declare function isTeamCostBuckets(value: unknown): value is TeamCostBuckets;
/** 校验一个成员成本行。 */
export declare function isTeamMemberCost(value: unknown): value is TeamMemberCost;
/** 校验团队成本汇总（快照边界 guard；形状回归时调用方整段省略而非发给坏形状）。 */
export declare function isTeamCostSummary(value: unknown): value is TeamCostSummary;
