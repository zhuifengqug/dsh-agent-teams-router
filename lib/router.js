/**
 * 任务难度 / 角色字段的校验与归一化。
 *
 * ## 2026-10-10 用户裁决（去路由）
 *
 * 本插件**不再依赖任何外部路由服务**。任务难度（`difficulty`）只是**任务自身的
 * 展示属性**，不参与、也不驱动任何模型选择；成员模型一律由用户在计划面板里
 * **逐成员选定**，并在创建时冻结写入 `team.json`（沿用既有冻结语义）。
 *
 * 因此本模块已删除原先的 Value Router 桥（服务键探测、`resolve()` 调用、
 * 决策形状收敛、审计事件记录）。派发线路不再是一个可解析的对象——它就是
 * 成员记录上的 `provider` / `model` / `reasoningEffort`。
 *
 * 保留下来的只有一件事：难度与角色是**任务记录的字段**，其合法性由记录的
 * owner（本插件）判定，非法值必须报错而不是静默回落。
 */
/** 四档难度（纯展示属性）。 */
export const TASK_DIFFICULTIES = ['low', 'medium', 'high', 'max'];
/** 缺省难度：没有任务描述时不猜难度。 */
export const DEFAULT_TASK_DIFFICULTY = 'medium';
/** 缺省角色。 */
export const DEFAULT_TASK_ROLE = 'general';
export function isTaskDifficulty(value) {
    return typeof value === 'string' && TASK_DIFFICULTIES.includes(value);
}
/**
 * 角色归一化：trim → 连续空白合并为单个空格 → Unicode 小写化。
 *
 * 仍然保留归一化，因为它是「同一个角色」的稳定判据（面板与提示词都按它展示），
 * 但它**不再参与任何成员复用键或线路派生**。
 */
export function normalizeRole(role) {
    if (typeof role !== 'string')
        return '';
    return role.trim().replace(/\s+/gu, ' ').toLowerCase();
}
/**
 * 归一化并校验任务的难度/角色字段。
 *
 * 缺省合法：`difficulty`→medium，`role`→general。
 * **显式给出非法值一律报错**——静默回落会让主模型以为"我标了 high"而实际存成 medium。
 */
export function validateTaskRouteFields(input) {
    const errors = [];
    let difficulty;
    if (input.difficulty === undefined || input.difficulty === null) {
        difficulty = DEFAULT_TASK_DIFFICULTY;
    }
    else if (isTaskDifficulty(input.difficulty)) {
        difficulty = input.difficulty;
    }
    else {
        errors.push(`invalid difficulty ${JSON.stringify(input.difficulty)}: expected one of low, medium, high, max`);
    }
    let role;
    if (input.role === undefined || input.role === null) {
        role = DEFAULT_TASK_ROLE;
    }
    else if (typeof input.role !== 'string') {
        errors.push(`invalid role ${JSON.stringify(input.role)}: expected a string`);
    }
    else if (normalizeRole(input.role) === '') {
        errors.push('invalid role: must contain at least one non-whitespace character');
    }
    else {
        role = input.role.trim();
    }
    if (errors.length > 0)
        return { ok: false, errors };
    return {
        ok: true,
        fields: {
            difficulty: difficulty,
            role: role,
            normalizedRole: normalizeRole(role),
        },
    };
}
