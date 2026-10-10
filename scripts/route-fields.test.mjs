/**
 * 任务难度 / 角色字段的行为测试（`src/router.ts`）。
 *
 * ## 2026-10-10 去路由退役（本文件重写）
 *
 * 本文件原先还钉着「Value Router 桥」：服务键 `VALUE_ROUTER_SERVICE_KEY`、
 * 能力探测 `valueRouterOf`、解析入口 `resolveTaskRoute`、决策形状收敛
 * `coerceResolution`、审计事件 `recordRouteEvent`，以及成员复用键
 * `memberReuseKey`（五段：difficulty · role · provider · model · effort）。
 * 用户裁决把这整套「任务难度 → 外部路由服务自动决定成员模型」机制退役后，
 * 这些导出**已从 `src/router.ts` 删除**，相关用例一并移除（没有可测对象）。
 *
 * ## 现在钉住的契约
 *
 * 难度与角色如今只是**任务自身的展示字段**，其合法性由本插件判定：
 * - 四档常量与缺省值（medium / general）；
 * - 显式非法值**必须报错**，绝不静默回落（否则主模型以为标了 high、实际存成 medium）；
 * - `normalizeRole` 的归一化向量（trim + 连续空白折叠 + Unicode 小写化）；
 * - `validateTaskRouteFields` 只接受 `{difficulty, role}`，返回值只有
 *   `difficulty` / `role` / `normalizedRole` 三个字段——**没有** `route` /
 *   `routeSource`（线路已不是任务的属性）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TASK_DIFFICULTY,
  DEFAULT_TASK_ROLE,
  TASK_DIFFICULTIES,
  isTaskDifficulty,
  normalizeRole,
  validateTaskRouteFields,
} from '../lib/router.js'

test('四档常量与缺省值', () => {
  assert.deepEqual([...TASK_DIFFICULTIES], ['low', 'medium', 'high', 'max'])
  assert.equal(DEFAULT_TASK_DIFFICULTY, 'medium')
  assert.equal(DEFAULT_TASK_ROLE, 'general')
})

test('isTaskDifficulty 只接受四档小写字面量', () => {
  for (const value of ['low', 'medium', 'high', 'max']) assert.equal(isTaskDifficulty(value), true)
  for (const value of ['LOW', 'critical', 'l', 3, true, null, undefined, {}]) assert.equal(isTaskDifficulty(value), false)
})

test('normalizeRole：trim + 连续空白合并 + Unicode 小写化', () => {
  const vectors = [
    ['  Senior   Engineer  ', 'senior engineer'],
    ['RESEARCHER', 'researcher'],
    ['RÉSUMÉ  WRITER', 'résumé writer'],
    ['ÄÖÜ', 'äöü'],
    ['a\t\n b', 'a b'],
    ['数据   分析', '数据 分析'],
    ['Data\u00a0Analyst', 'data analyst'],
    ['   ', ''],
  ]
  for (const [input, expected] of vectors) {
    assert.equal(normalizeRole(input), expected, `normalizeRole(${JSON.stringify(input)})`)
  }
  assert.equal(normalizeRole(undefined), '')
  assert.equal(normalizeRole(42), '')
})

test('缺省字段合法：difficulty=medium、role=general', () => {
  const result = validateTaskRouteFields({})
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.fields.difficulty, 'medium')
  assert.equal(result.fields.role, 'general')
  assert.equal(result.fields.normalizedRole, 'general')
})

test('返回值只有展示三字段：线路不再是任务的属性（去路由）', () => {
  const result = validateTaskRouteFields({ difficulty: 'high', role: 'engineer' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.fields).sort(), ['difficulty', 'normalizedRole', 'role'])
  assert.equal(result.fields.route, undefined)
  assert.equal(result.fields.routeSource, undefined)
  // 旧调用方可能多传了已退役的 `route` / `routeSource`：它们被**忽略**，不影响判定。
  const withRetired = validateTaskRouteFields({
    difficulty: 'high',
    role: 'engineer',
    route: { provider: 'p', model: 'm', reasoning_effort: '' },
    routeSource: 'robot',
  })
  assert.equal(withRetired.ok, true, '已退役的 route 参数不得再让校验失败')
  if (!withRetired.ok) return
  assert.deepEqual(withRetired.fields, result.fields)
})

test('非法 difficulty 必须显式报错（不静默回落）', () => {
  for (const bad of ['URGENT', 'critical', 7, true, {}]) {
    const result = validateTaskRouteFields({ difficulty: bad })
    assert.equal(result.ok, false, `difficulty=${JSON.stringify(bad)} 必须被拒`)
    if (result.ok) return
    assert.match(result.errors[0], /invalid difficulty/)
  }
})

test('非法 role 必须显式报错（空串 / 纯空白 / 非字符串）', () => {
  for (const bad of ['', '   ', 9, ['x']]) {
    const result = validateTaskRouteFields({ role: bad })
    assert.equal(result.ok, false, `role=${JSON.stringify(bad)} 必须被拒`)
    if (result.ok) return
    assert.match(result.errors[0], /invalid role/)
  }
})

test('合法 role 保留原文，同时给出归一化值', () => {
  const result = validateTaskRouteFields({ role: '  Code   Reviewer ' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.fields.role, 'Code   Reviewer')
  assert.equal(result.fields.normalizedRole, 'code reviewer')
})
