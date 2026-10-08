/**
 * agency-agents 可选桥——`@michengai/dsh-agency-agents` 的三个服务任一缺失即整体回落。
 *
 * ## 边界
 *
 * - **本插件完全不强依赖 agency-agents**：三个服务任一缺席（未安装、未启用、版本不匹配、
 *   形状不认识）都必须回到今天的 AgentTeams 行为，不报错、不降级、不发明替身。
 * - **三个服务只通过 `ctx.get()` 在调用时探测**（照 `src/router.ts` 的 `valueRouterOf()`）：
 *   模块级 `inject` 是**硬依赖**——写进 `inject` 数组会让 agency-agents 缺席时本插件
 *   整体不激活，与「任一缺失即整体回落」正好相反。
 * - **本模块全部是纯函数式形状**：服务句柄与方法返回值都以入参承接并自行校验形状，
 *   唯一接触 ctx 的入口是 `agencyServicesOf()`（只读 `get`），便于用 stub 做单测。
 *
 * ## 核实过的服务形状（`@michengai/dsh-agency-agents@1.0.11`，实读其构建产物）
 *
 * | 服务名 | 这里用到的方法 | 备注 |
 * | --- | --- | --- |
 * | `agencyAgentsTeams` | `list()`, `get(idOrName)` | team 成员是「角色 + 职责 + 指令」，**不是** persona 正文 |
 * | `agencyAgentsLibrary` | `catalog()` | 只查 expert 的 `division`，不预加载全量 persona 正文 |
 * | `agencyAgentsPersona` | `getPrompt(slug, division, locale)` | persona 正文按需读，且只读本团这几个成员 |
 *
 * 服务名/形状随版本演进由 {@link agencyServicesOf} 的最小方法集校验吸收：
 * 缺方法即视为缺席，整体回落。
 *
 * @module dsh-agent-teams/agency-bridge
 */
import { type TaskDifficulty } from './router.ts';
export declare const AGENCY_SERVICE_KEYS: {
    readonly teams: "agencyAgentsTeams";
    readonly library: "agencyAgentsLibrary";
    readonly persona: "agencyAgentsPersona";
};
/** 单个成员 persona 正文的字符上限（超出截断并记 diagnostics）。 */
export declare const PERSONA_MAX_CHARS = 8000;
/** locale 读不到时的缺省值。 */
export declare const DEFAULT_LOCALE = "zh";
/** 一个 agency team 的成员行（结构镜像 `TeamInput.members[]`）。 */
export interface AgencyMemberRow {
    expertSlug?: string;
    duty?: string;
    instructions?: string;
}
/** agency team（结构镜像 `TeamInput`）。 */
export interface AgencyTeam {
    id?: string;
    name?: string;
    description?: string;
    goal?: string;
    constraints?: string;
    deliveryRequirements?: string;
    coordinatorPrompt?: string;
    members?: AgencyMemberRow[];
}
/** 一个 catalog expert（结构镜像 `CatalogSnapshot.experts[]`）。 */
export interface AgencyExpert {
    slug?: string;
    division?: string;
}
/** `agencyAgentsTeams` 的最小可用方法集。 */
export interface AgencyTeamsServiceLike {
    list?: () => unknown;
    get?: (idOrName: string) => unknown;
}
/** `agencyAgentsLibrary` 的最小可用方法集。 */
export interface AgencyLibraryServiceLike {
    catalog?: () => unknown;
}
/** `agencyAgentsPersona` 的最小可用方法集。 */
export interface AgencyPersonaServiceLike {
    getPrompt?: (slug: string, division: string, locale: string) => unknown;
}
/** 三个服务都通过形状校验后的句柄。 */
export interface AgencyServices {
    teams: AgencyTeamsServiceLike;
    library: AgencyLibraryServiceLike;
    persona: AgencyPersonaServiceLike;
}
export interface AgencyServicesAbsent {
    available: false;
    /** 缺席的服务键；用于给用户一条可读的原因。 */
    missing: string[];
}
export interface AgencyServicesPresent {
    available: true;
    services: AgencyServices;
}
export type AgencyServiceOutcome = AgencyServicesAbsent | AgencyServicesPresent;
/**
 * 能力探测：三个服务都在且方法都是函数就返回句柄，否则返回缺席。
 *
 * **永不抛错**（DESIGN A.4：服务缺失时必须功能完全回落，无异常日志）。
 * 与 `valueRouterOf()` 的差别只有「三个而不是一个」。
 */
export declare function agencyServicesOf(ctx: {
    get(key: never): unknown;
} | undefined): AgencyServiceOutcome;
/**
 * 读客户端 locale（`ctx.locale.getLocale().active`），读不到返回 undefined。
 *
 * `locale` 是 client-plane 服务（headless/工具侧常常不在），所以这里沿用
 * `ctx.get()` 的探测纪律：**不在 `inject` 里声明，读不到就当没有**，由调用方落到
 * {@link DEFAULT_LOCALE}。任何异常（形状不同、getter 抛错）都必须静默回落，
 * 不能让 locale 探测影响建团。
 */
export declare function clientLocaleOf(ctx: {
    get(key: never): unknown;
} | undefined): string | undefined;
/** 服务缺席时给调用方的可读原因。 */
export declare function agencyUnavailableReason(outcome: AgencyServicesAbsent): string;
/** 一条成员级诊断（降级/兜底/改名都必须留可追溯的痕迹）。 */
export interface AgencyDiagnostic {
    /** 该诊断属于哪个成员名（合成后的最终名字）。 */
    member: string;
    code: 'persona-missing' | 'persona-truncated' | 'name-collision' | 'expert-unknown';
    detail: string;
}
/** 装配出来的一个成员候补（工具层再转成 `TeamMember`）。 */
export interface AssembledMember {
    name: string;
    /** 留空 —— 交给 value-router 四档派发。 */
    provider: undefined;
    model: undefined;
    reasoningEffort: undefined;
    /** persona + 「## 本次职责」+「## 补充指令」。 */
    executionPrompt: string;
    /** 该成员自身的诊断（没有则为空数组）。 */
    diagnostics: AgencyDiagnostic[];
}
/** agency team 的主理人字段：create 响应回显给队长采纳，不写进提示词管线。 */
export interface AgencyCoordinatorFields {
    coordinatorPrompt?: string;
    constraints?: string;
    deliveryRequirements?: string;
    goal?: string;
}
export interface AgencyAssemblyResult {
    members: AssembledMember[];
    diagnostics: AgencyDiagnostic[];
    coordinator: AgencyCoordinatorFields;
    /** agency team 自己的名字（用于报错与回显）。 */
    teamName?: string;
}
/** 装配结果：成功或一条给用户看的英文原因。 */
export type AgencyAssemblyResultOrError = {
    ok: true;
    result: AgencyAssemblyResult;
} | {
    ok: false;
    error: string;
};
/**
 * 从 `agencyAgentsTeams` 取一个团队（按 id 或 name 匹配）。
 *
 * 优先 `get(idOrName)`；它不可用或不命中时用 `list()` 做一次 id/name 精确回落，
 * 仍不命中就报错并**列出可用 team id**（DESIGN A.3：不静默回落）。
 */
export declare function resolveAgencyTeam(services: AgencyServices, idOrName: string): {
    ok: true;
    team: AgencyTeam;
} | {
    ok: false;
    error: string;
};
/**
 * 合成一个成员的 `executionPrompt`：persona 正文 + 「## 本次职责」+「## 补充指令」。
 *
 * 缺哪个 section 省哪个，不补占位文字；persona 缺时只剩后两段（由调用方记 diagnostics）。
 */
export declare function composeExecutionPrompt(persona: string | undefined, duty?: string, instructions?: string): string;
/**
 * 把 agency team 装配成 AgentTeams 成员候补。
 *
 * 纪律（DESIGN A.2 / A.3）：
 * - `name` = expertSlug；**同一 slug 重复出现时加 `-2`/`-3` 后缀**并记 diagnostics
 *   （persona 仍按原 slug 拉取，改名不影响正文）；
 * - `provider`/`model`/`reasoningEffort` **全部留空** → 走 value-router 四档；
 * - persona 正文按需读，且**只读本团这几个成员**，不预加载全量 catalog 正文；
 * - persona 超 {@link PERSONA_MAX_CHARS} 截断 + diagnostics；
 *   缺 persona 用 duty + instructions 兜底 + diagnostics；
 * - 阵容超 `maxMembers` **明确报错，不静默截断**。
 */
export declare function assembleAgencyTeam(input: {
    services: AgencyServices;
    team: AgencyTeam;
    maxMembers: number;
    locale: string;
}): Promise<AgencyAssemblyResultOrError>;
/**
 * The agency conflict matrix, kept pure so it can be asserted without a studio.
 *
 * - `agencyTeam` × `profile` → error（roster 只能有一个 owner）
 * - `agencyTeam` × `plan.members` → error
 * - `agencyTeam` × `plan.tasks` → **allowed**（任务图与阵容正交）
 * - 三者都不给 → 现有行为（captain 自组队）
 *
 * Blank optional strings count as omissions, exactly like `profile` (issue #99).
 *
 * @returns the trimmed agency reference, plus the inline task rows it is
 *   allowed to ride along with (an empty array when there are none).
 */
export declare function resolveAgencyCreateRequest(args: {
    agencyTeam?: unknown;
    profile?: unknown;
    plan?: {
        members?: unknown;
        tasks?: unknown;
    } | null;
}): {
    ok: true;
    agencyTeam?: string;
} | {
    ok: false;
    error: string;
};
/**
 * 一次性走完「探测 → 取团 → 装配」（工具层的唯一入口）。
 *
 * 服务缺席返回 `available:false`，调用方据此拒绝 `agencyTeam` 参数并给出原因；
 * 其余失败（team 不存在 / 阵容超 maxMembers）返回可读英文 error。
 */
export declare function loadAgencyTeam(input: {
    ctx: {
        get(key: never): unknown;
    } | undefined;
    idOrName: string;
    maxMembers: number;
    locale: string;
}): Promise<{
    ok: true;
    available: true;
    assembly: AgencyAssemblyResult;
} | {
    ok: false;
    available: false;
    reason: string;
}>;
/** 一条随 agency 阵容一起来的队长任务行（工具侧的 raw shape）。 */
export interface AgencyPlanTaskRow {
    id: string;
    subject: string;
    description?: string;
    assignee?: string;
    dependencies: string[];
    difficulty: TaskDifficulty;
    role: string;
    normalizedRole: string;
    route?: {
        provider: string;
        model: string;
        reasoning_effort: string;
    };
}
/**
 * 校验并拓扑排序 `create({agencyTeam, plan.tasks})` 里的任务行。
 *
 * 阵容来自 agency 团队，这里只管 DAG 那一半：本地 `id` 引用、subject、依赖与路由
 * 意图（`router.ts` 的 `validateTaskRouteFields` 是唯一判官）。`plan.tasks` 与
 * `agencyTeam` 允许共存正是因为二者正交——任务图不描述人。
 *
 * 入参是 `unknown`：这些值跨模型工具边界进来，形状一律在此收敛。
 */
export declare function normalizeAgencyPlanTasks(tasks: readonly unknown[]): AgencyPlanTaskRow[];
