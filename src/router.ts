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
export const VALUE_ROUTER_SERVICE_KEY = 'valueRouterRouting'

/** 四档难度。 */
export const TASK_DIFFICULTIES = ['low', 'medium', 'high', 'max'] as const

export type TaskDifficulty = (typeof TASK_DIFFICULTIES)[number]

/** 缺省难度：没有任务描述时不猜难度。 */
export const DEFAULT_TASK_DIFFICULTY: TaskDifficulty = 'medium'

/** 缺省角色。 */
export const DEFAULT_TASK_ROLE = 'general'

export function isTaskDifficulty(value: unknown): value is TaskDifficulty {
  return typeof value === 'string' && (TASK_DIFFICULTIES as readonly string[]).includes(value)
}

/**
 * 角色归一化：trim → 连续空白合并为单个空格 → Unicode 小写化。
 *
 * **必须与 `dsh-value-router` 的 `normalizeRole` 逐字一致**：本插件的成员复用键
 * 用的是这个值，而路由决策用的是 Value Router 侧的值；两者漂移会让"同一个角色"
 * 被算成两个成员。
 */
export function normalizeRole(role: unknown): string {
  if (typeof role !== 'string') return ''
  return role.trim().replace(/\s+/gu, ' ').toLowerCase()
}

/**
 * 成员复用键：`difficulty + normalizedRole + provider + model + reasoning_effort`。
 *
 * 五段用 `\u0000` 连接，避免角色文本里的分隔符与结构撞车。
 */
export function memberReuseKey(input: {
  difficulty: TaskDifficulty | string
  normalizedRole: string
  provider: string
  model: string
  reasoning_effort?: string
}): string {
  return [
    input.difficulty,
    input.normalizedRole,
    input.provider,
    input.model,
    input.reasoning_effort ?? '',
  ].join('\u0000')
}

/** 一条显式线路（三字段都可缺；归一化后保证是字符串）。 */
export interface TaskRouteLine {
  provider: string
  model: string
  reasoning_effort: string
}

/** 线路来源。`user` = 用户硬指定；`captain` = 主模型偏好。 */
export type TaskRouteSource = 'user' | 'captain' | 'difficulty' | 'fallback' | 'none'

/** 路由结果状态。仅 `resolved` 可派发。 */
export type TaskRouteStatus = 'resolved' | 'pending' | 'blocked'

/** 一个档位。 */
export type TaskTier = TaskDifficulty

/** 审计条目（结构镜像，字段与 Value Router 的 `RouteAuditEntry` 对齐）。 */
export interface TaskRouteAuditEntry {
  at: number
  step: string
  outcome: string
  detail: string
  tier?: string
  route?: Partial<TaskRouteLine> & { status?: string }
}

/** 一次路由决策（结构镜像 Value Router 的 `RouteResolution`）。 */
export interface TaskRouteResolution {
  provider: string
  model: string
  reasoning_effort: string
  routeSource: TaskRouteSource
  routeStatus: TaskRouteStatus
  fallback: boolean
  degraded: boolean
  dispatchable: boolean
  reason?: string
  audit: TaskRouteAuditEntry[]
}

/** 任务上的路由字段（持久化形状）。 */
export interface TaskRouteFields {
  difficulty: TaskDifficulty
  /** 原始自由文本（保持用户/主模型写下的样子）。 */
  role: string
  /** 归一化角色（成员复用键的一段）。 */
  normalizedRole: string
  /** 显式线路；未给出时不存在。 */
  route?: TaskRouteLine
  /** 显式线路的来源；只有 `route` 存在时才有意义。 */
  routeSource?: 'user' | 'captain'
  /** 最近一次解析结果的状态。 */
  routeStatus?: TaskRouteStatus
  /** 最近一次解析结果的来源。 */
  routeSourceResolved?: TaskRouteSource
  /** 最近一次解析的审计。 */
  routeAudit?: TaskRouteAuditEntry[]
}

/** 校验结果。 */
export type TaskRouteFieldValidation =
  | { ok: true; fields: TaskRouteFields }
  | { ok: false; errors: string[] }

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * 归一化并校验任务路由字段。
 *
 * 缺省合法：`difficulty`→medium，`role`→general。
 * **显式给出非法值一律报错**——静默回落会让主模型以为"我标了 high"而实际跑在 medium。
 */
export function validateTaskRouteFields(input: {
  difficulty?: unknown
  role?: unknown
  route?: { provider?: unknown; model?: unknown; reasoning_effort?: unknown } | null
  routeSource?: unknown
}): TaskRouteFieldValidation {
  const errors: string[] = []

  let difficulty: TaskDifficulty | undefined
  if (input.difficulty === undefined || input.difficulty === null) {
    difficulty = DEFAULT_TASK_DIFFICULTY
  } else if (isTaskDifficulty(input.difficulty)) {
    difficulty = input.difficulty
  } else {
    errors.push(`invalid difficulty ${JSON.stringify(input.difficulty)}: expected one of low, medium, high, max`)
  }

  let role: string | undefined
  if (input.role === undefined || input.role === null) {
    role = DEFAULT_TASK_ROLE
  } else if (typeof input.role !== 'string') {
    errors.push(`invalid role ${JSON.stringify(input.role)}: expected a string`)
  } else if (normalizeRole(input.role) === '') {
    errors.push('invalid role: must contain at least one non-whitespace character')
  } else {
    role = input.role.trim()
  }

  let route: TaskRouteLine | undefined
  let routeSource: 'user' | 'captain' | undefined
  if (input.route !== undefined && input.route !== null) {
    if (typeof input.route !== 'object') {
      errors.push('invalid route: expected an object with provider/model/reasoning_effort')
    } else {
      const candidate: TaskRouteLine = {
        provider: str(input.route.provider),
        model: str(input.route.model),
        reasoning_effort: str(input.route.reasoning_effort),
      }
      if (candidate.provider === '' || candidate.model === '') {
        errors.push('invalid route: provider and model must both be non-empty')
      } else if (input.routeSource !== undefined && input.routeSource !== 'user' && input.routeSource !== 'captain') {
        errors.push(`invalid routeSource ${JSON.stringify(input.routeSource)}: expected user or captain`)
      } else {
        route = candidate
        routeSource = input.routeSource === 'user' ? 'user' : 'captain'
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors }
  return {
    ok: true,
    fields: {
      difficulty: difficulty!,
      role: role!,
      normalizedRole: normalizeRole(role),
      ...(route === undefined ? {} : { route }),
      ...(routeSource === undefined ? {} : { routeSource }),
    },
  }
}

/**
 * Value Router 服务的**结构镜像**。只描述本插件真正调用到的方法，
 * 用 `unknown` 承接返回，再由本模块自己校验形状——这样服务版本演进不会把
 * 类型错误炸进本插件的编译产物。
 */
export interface ValueRouterServiceLike {
  resolve?: (input: Record<string, unknown>) => Promise<unknown>
  record?: (event: Record<string, unknown>) => void
}

/** 能力探测：服务在就返回它，不在就返回 undefined。绝不抛错。 */
export function valueRouterOf(ctx: { get(key: never): unknown } | undefined): ValueRouterServiceLike | undefined {
  if (ctx === undefined) return undefined
  try {
    const service = ctx.get(VALUE_ROUTER_SERVICE_KEY as never) as ValueRouterServiceLike | undefined
    if (service === undefined || service === null) return undefined
    if (typeof service.resolve !== 'function') return undefined
    return service
  } catch {
    return undefined
  }
}

/** 服务缺席时调用方必须走的路：保持原行为，不产生路由决策。 */
export interface ValueRouterAbsent {
  available: false
}

export interface ValueRouterPresent {
  available: true
  resolution: TaskRouteResolution
}

export type TaskRouteOutcome = ValueRouterAbsent | ValueRouterPresent

/** 把服务返回值收敛成受控形状；形状不认识时视为不可派发，而不是猜。 */
export function coerceResolution(value: unknown, at: number): TaskRouteResolution {
  const record = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>
  const status = record['routeStatus']
  const routeStatus: TaskRouteStatus = status === 'resolved' || status === 'pending' || status === 'blocked'
    ? status
    : 'pending'
  const source = record['routeSource']
  const routeSource: TaskRouteSource = source === 'user' || source === 'captain'
    || source === 'difficulty' || source === 'fallback' || source === 'none'
    ? source
    : 'none'
  const audit = Array.isArray(record['audit'])
    ? (record['audit'] as unknown[]).filter((entry): entry is TaskRouteAuditEntry =>
      typeof entry === 'object' && entry !== null
      && typeof (entry as Record<string, unknown>)['detail'] === 'string')
    : []
  const provider = str(record['provider'])
  const model = str(record['model'])
  const dispatchable = record['dispatchable'] === true && routeStatus === 'resolved'
    && provider !== '' && model !== ''
  return {
    provider,
    model,
    reasoning_effort: str(record['reasoning_effort']),
    routeSource,
    routeStatus,
    fallback: record['fallback'] === true,
    degraded: record['degraded'] === true,
    dispatchable,
    ...(typeof record['reason'] === 'string' ? { reason: record['reason'] } : {}),
    // 服务没给审计时补一条说明——但要说清是哪一种：不可信形状，还是服务单纯没带审计。
    audit: audit.length > 0 ? audit : [{
      at,
      step: dispatchable ? 'service' : 'unknown',
      outcome: dispatchable ? 'ok' : 'skipped',
      detail: dispatchable
        ? 'Value Router 未返回审计条目'
        : 'Value Router 返回的形状无法识别，按不可派发处理',
    }],
  }
}

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
export async function resolveTaskRoute(
  service: ValueRouterServiceLike | undefined,
  input: {
    difficulty: TaskDifficulty | string
    role: string
    route?: TaskRouteLine | undefined
    routeSource?: 'user' | 'captain' | undefined
    rotationIndex?: number | undefined
    teamId?: string | undefined
    taskId?: string | undefined
  },
  at: number = Date.now(),
): Promise<TaskRouteOutcome> {
  if (service === undefined || typeof service.resolve !== 'function') return { available: false }
  try {
    const raw = await service.resolve({
      difficulty: input.difficulty,
      role: input.role,
      ...(input.route === undefined ? {} : { route: input.route }),
      ...(input.routeSource === undefined ? {} : { routeSource: input.routeSource }),
      ...(input.rotationIndex === undefined ? {} : { rotationIndex: input.rotationIndex }),
      ...(input.teamId === undefined ? {} : { teamId: input.teamId }),
      ...(input.taskId === undefined ? {} : { taskId: input.taskId }),
    })
    return { available: true, resolution: coerceResolution(raw, at) }
  } catch (error) {
    return {
      available: true,
      resolution: {
        provider: '', model: '', reasoning_effort: '',
        routeSource: 'none',
        routeStatus: 'blocked',
        fallback: false,
        degraded: false,
        dispatchable: false,
        reason: 'router-error',
        audit: [{
          at,
          step: 'blocked',
          outcome: 'blocked',
          detail: `Value Router 解析失败：${error instanceof Error ? error.message : String(error)}`,
        }],
      },
    }
  }
}

/** 追加一条运行事件（服务缺席时静默跳过）。 */
export function recordRouteEvent(
  service: ValueRouterServiceLike | undefined,
  event: Record<string, unknown>,
): void {
  if (service === undefined || typeof service.record !== 'function') return
  try {
    service.record(event)
  } catch {
    // 审计永远不能影响调度。
  }
}
