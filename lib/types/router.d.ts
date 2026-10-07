/**
 * Value Router 桥——**可选的** Cordis 服务能力探测。
 *
 * ## 边界（与 dsh-value-router 的分工）
 *
 * - `dsh-value-router` 是**唯一路由 owner**：它决定 provider/model/reasoning_effort。
 * - 本插件负责团队状态、DAG、attempt、成员生命周期与冻结写入，**只消费**路由决策。
 * - 本模块**不 import `dsh-value-router` 的任何东西**：服务缺席时（未安装、未启用、
 *   版本不匹配）整个插件必须保持今天的行为，不报错、不降级、不发明替身。
 * - 本模块也**不读写 `.agent-teams/team.json`**：路由快照由调用方在自身锁内写盘。
 *
 * ## 为什么任务字段的 schema 校验留在这里
 *
 * `difficulty` / `role` / `normalizedRole` 是**任务记录的字段**，它们的合法性必须由
 * 记录的 owner 判定——否则 Value Router 没装时，非法难度就会被静默接受。
 * 归一化规则与 `dsh-value-router` 的 `core/intent.ts` 必须一致（见
 * `test/route-fields.test.mjs` 里两边共用的向量），但判定权在这里。
 */
/** 服务在 Cordis 里的键名（与 dsh-value-router 的 `VALUE_ROUTER_SERVICE_NAME` 一致）。 */
export declare const VALUE_ROUTER_SERVICE_KEY = "valueRouterRouting";
/** 四档难度。 */
export declare const TASK_DIFFICULTIES: readonly ["low", "medium", "high", "max"];
export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number];
/** 缺省难度：没有任务描述时不猜难度。 */
export declare const DEFAULT_TASK_DIFFICULTY: TaskDifficulty;
/** 缺省角色。 */
export declare const DEFAULT_TASK_ROLE = "general";
export declare function isTaskDifficulty(value: unknown): value is TaskDifficulty;
/**
 * 角色归一化：trim → 连续空白合并为单个空格 → Unicode 小写化。
 *
 * **必须与 `dsh-value-router` 的 `normalizeRole` 逐字一致**：本插件的成员复用键
 * 用的是这个值，而路由决策用的是 Value Router 侧的值；两者漂移会让"同一个角色"
 * 被算成两个成员。
 */
export declare function normalizeRole(role: unknown): string;
/**
 * 成员复用键：`difficulty + normalizedRole + provider + model + reasoning_effort`。
 *
 * 五段用 `\u0000` 连接，避免角色文本里的分隔符与结构撞车。
 */
export declare function memberReuseKey(input: {
    difficulty: TaskDifficulty | string;
    normalizedRole: string;
    provider: string;
    model: string;
    reasoning_effort?: string;
}): string;
/** 一条显式线路（三字段都可缺；归一化后保证是字符串）。 */
export interface TaskRouteLine {
    provider: string;
    model: string;
    reasoning_effort: string;
}
/** 线路来源。`user` = 用户硬指定；`captain` = 主模型偏好。 */
export type TaskRouteSource = 'user' | 'captain' | 'difficulty' | 'fallback' | 'none';
/** 路由结果状态。仅 `resolved` 可派发。 */
export type TaskRouteStatus = 'resolved' | 'pending' | 'blocked';
/** 一个档位。 */
export type TaskTier = TaskDifficulty;
/** 审计条目（结构镜像，字段与 Value Router 的 `RouteAuditEntry` 对齐）。 */
export interface TaskRouteAuditEntry {
    at: number;
    step: string;
    outcome: string;
    detail: string;
    tier?: string;
    route?: Partial<TaskRouteLine> & {
        status?: string;
    };
}
/** 一次路由决策（结构镜像 Value Router 的 `RouteResolution`）。 */
export interface TaskRouteResolution {
    provider: string;
    model: string;
    reasoning_effort: string;
    routeSource: TaskRouteSource;
    routeStatus: TaskRouteStatus;
    fallback: boolean;
    degraded: boolean;
    dispatchable: boolean;
    reason?: string;
    audit: TaskRouteAuditEntry[];
}
/** 任务上的路由字段（持久化形状）。 */
export interface TaskRouteFields {
    difficulty: TaskDifficulty;
    /** 原始自由文本（保持用户/主模型写下的样子）。 */
    role: string;
    /** 归一化角色（成员复用键的一段）。 */
    normalizedRole: string;
    /** 显式线路；未给出时不存在。 */
    route?: TaskRouteLine;
    /** 显式线路的来源；只有 `route` 存在时才有意义。 */
    routeSource?: 'user' | 'captain';
    /** 最近一次解析结果的状态。 */
    routeStatus?: TaskRouteStatus;
    /** 最近一次解析结果的来源。 */
    routeSourceResolved?: TaskRouteSource;
    /** 最近一次解析的审计。 */
    routeAudit?: TaskRouteAuditEntry[];
}
/** 校验结果。 */
export type TaskRouteFieldValidation = {
    ok: true;
    fields: TaskRouteFields;
} | {
    ok: false;
    errors: string[];
};
/**
 * 归一化并校验任务路由字段。
 *
 * 缺省合法：`difficulty`→medium，`role`→general。
 * **显式给出非法值一律报错**——静默回落会让主模型以为"我标了 high"而实际跑在 medium。
 */
export declare function validateTaskRouteFields(input: {
    difficulty?: unknown;
    role?: unknown;
    route?: {
        provider?: unknown;
        model?: unknown;
        reasoning_effort?: unknown;
    } | null;
    routeSource?: unknown;
}): TaskRouteFieldValidation;
/**
 * Value Router 服务的**结构镜像**。只描述本插件真正调用到的方法，
 * 用 `unknown` 承接返回，再由本模块自己校验形状——这样服务版本演进不会把
 * 类型错误炸进本插件的编译产物。
 */
export interface ValueRouterServiceLike {
    resolve?: (input: Record<string, unknown>) => Promise<unknown>;
    record?: (event: Record<string, unknown>) => void;
}
/** 能力探测：服务在就返回它，不在就返回 undefined。绝不抛错。 */
export declare function valueRouterOf(ctx: {
    get(key: never): unknown;
} | undefined): ValueRouterServiceLike | undefined;
/** 服务缺席时调用方必须走的路：保持原行为，不产生路由决策。 */
export interface ValueRouterAbsent {
    available: false;
}
export interface ValueRouterPresent {
    available: true;
    resolution: TaskRouteResolution;
}
export type TaskRouteOutcome = ValueRouterAbsent | ValueRouterPresent;
/** 把服务返回值收敛成受控形状；形状不认识时视为不可派发，而不是猜。 */
export declare function coerceResolution(value: unknown, at: number): TaskRouteResolution;
/**
 * 解析一次任务路由。
 *
 * - **服务缺席** → 返回 `{ available: false }`，调用方必须保持原行为（成员继承队长线路）。
 * - **服务在** → 调用 `resolve()` 并收敛形状。`dispatchable=false` 时调用方
 *   **不得**派发该任务，也不得自行降级或换线路。
 *
 * 永不抛错：服务抛出的异常收敛成一次 `blocked` 决策，让任务停在待定而不是把
 * 异常炸进调度器。
 */
export declare function resolveTaskRoute(service: ValueRouterServiceLike | undefined, input: {
    difficulty: TaskDifficulty | string;
    role: string;
    route?: TaskRouteLine | undefined;
    routeSource?: 'user' | 'captain' | undefined;
    rotationIndex?: number | undefined;
    teamId?: string | undefined;
    taskId?: string | undefined;
}, at?: number): Promise<TaskRouteOutcome>;
/** 追加一条运行事件（服务缺席时静默跳过）。 */
export declare function recordRouteEvent(service: ValueRouterServiceLike | undefined, event: Record<string, unknown>): void;
