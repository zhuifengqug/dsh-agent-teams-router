/**
 * 任务路由字段 + Value Router 桥的行为测试。
 *
 * 覆盖：
 * - difficulty / role 的缺省与**显式非法必须报错**；
 * - 归一化向量与 dsh-value-router 的 `core/intent.ts` 保持一致；
 * - 成员复用键五段参与；
 * - Value Router 服务缺席时返回 `{available:false}`（调用方保持原行为）；
 * - 服务返回值形状不认识时按不可派发处理，绝不猜；
 * - 服务抛错不炸穿调用方。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_TASK_DIFFICULTY,
  DEFAULT_TASK_ROLE,
  TASK_DIFFICULTIES,
  VALUE_ROUTER_SERVICE_KEY,
  coerceResolution,
  isTaskDifficulty,
  memberReuseKey,
  normalizeRole,
  recordRouteEvent,
  resolveTaskRoute,
  validateTaskRouteFields,
  valueRouterOf,
} from '../lib/router.js'

test('四档常量与缺省值', () => {
  assert.deepEqual([...TASK_DIFFICULTIES], ['low', 'medium', 'high', 'max'])
  assert.equal(DEFAULT_TASK_DIFFICULTY, 'medium')
  assert.equal(DEFAULT_TASK_ROLE, 'general')
  assert.equal(VALUE_ROUTER_SERVICE_KEY, 'valueRouterRouting')
})

test('isTaskDifficulty 只接受四档小写字面量', () => {
  for (const value of ['low', 'medium', 'high', 'max']) assert.equal(isTaskDifficulty(value), true)
  for (const value of ['LOW', 'critical', 'l', 3, true, null, undefined, {}]) assert.equal(isTaskDifficulty(value), false)
})

test('normalizeRole：trim + 连续空白合并 + Unicode 小写化（与 value-router 共用同一组向量）', () => {
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

test('缺省字段合法：difficulty=medium、role=general、无 route', () => {
  const result = validateTaskRouteFields({})
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.equal(result.fields.difficulty, 'medium')
  assert.equal(result.fields.role, 'general')
  assert.equal(result.fields.normalizedRole, 'general')
  assert.equal(result.fields.route, undefined)
  assert.equal(result.fields.routeSource, undefined)
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

test('显式线路：三段齐全才合法，来源缺省为 captain，显式 user 被保留', () => {
  const asCaptain = validateTaskRouteFields({ route: { provider: 'p', model: 'm' } })
  assert.equal(asCaptain.ok, true)
  if (!asCaptain.ok) return
  assert.deepEqual(asCaptain.fields.route, { provider: 'p', model: 'm', reasoning_effort: '' })
  assert.equal(asCaptain.fields.routeSource, 'captain')

  const asUser = validateTaskRouteFields({ route: { provider: 'p', model: 'm', reasoning_effort: 'high' }, routeSource: 'user' })
  assert.equal(asUser.ok, true)
  if (!asUser.ok) return
  assert.equal(asUser.fields.routeSource, 'user')
  assert.equal(asUser.fields.route.reasoning_effort, 'high')

  for (const bad of [{ provider: 'p' }, { model: 'm' }, {}, 'nope']) {
    const result = validateTaskRouteFields({ route: bad })
    assert.equal(result.ok, false, `route=${JSON.stringify(bad)} 必须被拒`)
  }
  const badSource = validateTaskRouteFields({ route: { provider: 'p', model: 'm' }, routeSource: 'robot' })
  assert.equal(badSource.ok, false)
  if (!badSource.ok) assert.match(badSource.errors[0], /invalid routeSource/)
})

test('成员复用键：五段参与，任何一段变化都必须换键', () => {
  const base = { difficulty: 'medium', normalizedRole: 'engineer', provider: 'p', model: 'm', reasoning_effort: 'high' }
  assert.equal(memberReuseKey(base), memberReuseKey({ ...base }))
  assert.notEqual(memberReuseKey(base), memberReuseKey({ ...base, difficulty: 'high' }))
  assert.notEqual(memberReuseKey(base), memberReuseKey({ ...base, normalizedRole: 'reviewer' }))
  assert.notEqual(memberReuseKey(base), memberReuseKey({ ...base, provider: 'q' }))
  assert.notEqual(memberReuseKey(base), memberReuseKey({ ...base, model: 'n' }))
  assert.notEqual(memberReuseKey(base), memberReuseKey({ ...base, reasoning_effort: '' }))
  assert.equal(
    memberReuseKey({ ...base, reasoning_effort: undefined }),
    memberReuseKey({ ...base, reasoning_effort: '' }),
  )
  // 角色里的分隔符不会与结构撞车
  assert.notEqual(
    memberReuseKey({ difficulty: 'low', normalizedRole: 'a\u0000b', provider: 'p', model: 'm' }),
    memberReuseKey({ difficulty: 'low', normalizedRole: 'a', provider: 'b', model: 'p' }),
  )
})

test('能力探测：服务缺席 / 缺 resolve / ctx 抛错 都返回 undefined', () => {
  assert.equal(valueRouterOf(undefined), undefined)
  assert.equal(valueRouterOf({ get: () => undefined }), undefined)
  assert.equal(valueRouterOf({ get: () => null }), undefined)
  assert.equal(valueRouterOf({ get: () => ({}) }), undefined, '没有 resolve 不算服务')
  assert.equal(valueRouterOf({ get: () => { throw new Error('nope') } }), undefined)
  const service = { resolve: async () => ({}) }
  assert.equal(valueRouterOf({ get: () => service }), service)
})

test('服务缺席时 resolveTaskRoute 返回 {available:false}——调用方必须保持原行为', async () => {
  const outcome = await resolveTaskRoute(undefined, { difficulty: 'low', role: 'general' })
  assert.deepEqual(outcome, { available: false })
})

test('服务在场时透传 difficulty/role/route/routeSource 并收敛返回形状', async () => {
  const seen = []
  const service = {
    resolve: async (input) => {
      seen.push(input)
      return {
        provider: 'p', model: 'm', reasoning_effort: 'high',
        routeSource: 'user', routeStatus: 'resolved',
        fallback: false, degraded: false, dispatchable: true,
        audit: [{ at: 1, step: 'user-route', outcome: 'ok', detail: '用户硬路由' }],
      }
    },
  }
  const outcome = await resolveTaskRoute(service, {
    difficulty: 'high', role: 'Reviewer', route: { provider: 'p', model: 'm', reasoning_effort: 'high' },
    routeSource: 'user', rotationIndex: 2, teamId: 't1', taskId: 'k1',
  }, 5)
  assert.equal(outcome.available, true)
  if (!outcome.available) return
  assert.equal(outcome.resolution.dispatchable, true)
  assert.equal(outcome.resolution.provider, 'p')
  assert.equal(outcome.resolution.routeSource, 'user')
  assert.deepEqual(seen[0], {
    difficulty: 'high', role: 'Reviewer',
    route: { provider: 'p', model: 'm', reasoning_effort: 'high' },
    routeSource: 'user', rotationIndex: 2, teamId: 't1', taskId: 'k1',
  })
})

test('服务返回 dispatchable=false 时必须原样传达（调用方不得派发）', async () => {
  const service = {
    resolve: async () => ({
      provider: '', model: '', reasoning_effort: '',
      routeSource: 'user', routeStatus: 'pending', fallback: false, degraded: false,
      dispatchable: false, reason: 'user-route-unavailable',
      audit: [{ at: 1, step: 'user-route', outcome: 'pending', detail: '用户硬路由当前不可用' }],
    }),
  }
  const outcome = await resolveTaskRoute(service, { difficulty: 'low', role: 'general' })
  assert.equal(outcome.available, true)
  if (!outcome.available) return
  assert.equal(outcome.resolution.dispatchable, false)
  assert.equal(outcome.resolution.routeStatus, 'pending')
  assert.equal(outcome.resolution.reason, 'user-route-unavailable')
})

test('coerceResolution：形状完整时可信，形状不可信时按不可派发处理', () => {
  // 形状完整的 resolved 载荷按契约可信（服务没带 audit 时补一条说明）。
  const trusted = coerceResolution({
    provider: 'p', model: 'm', routeStatus: 'resolved', routeSource: 'difficulty', dispatchable: true,
  }, 7)
  assert.equal(trusted.dispatchable, true)
  assert.equal(trusted.audit[0].step, 'service')
  assert.match(trusted.audit[0].detail, /未返回审计条目/)

  // 未知状态收敛为 pending，并留下"形状无法识别"的说明。
  const unknown = coerceResolution({ provider: 'p', model: 'm', routeStatus: 'weird', dispatchable: true }, 7)
  assert.equal(unknown.dispatchable, false)
  assert.equal(unknown.routeStatus, 'pending')
  assert.equal(unknown.audit[0].step, 'unknown')
  assert.match(unknown.audit[0].detail, /形状无法识别/)

  const empty = coerceResolution(undefined, 7)
  assert.equal(empty.dispatchable, false)
  assert.equal(empty.routeSource, 'none')

  // 声称 resolved/dispatchable 但 provider 为空 → 不可派发
  const hollow = coerceResolution({
    provider: '', model: 'm', routeStatus: 'resolved', dispatchable: true, routeSource: 'difficulty',
    audit: [{ at: 1, step: 'tier-rotate', outcome: 'ok', detail: 'x' }],
  }, 7)
  assert.equal(hollow.dispatchable, false)

  // 认得的 audit 条目被保留，不被合成条目替换
  const kept = coerceResolution({
    provider: 'p', model: 'm', routeStatus: 'resolved', routeSource: 'difficulty', dispatchable: true,
    audit: [{ at: 1, step: 'tier-rotate', outcome: 'ok', detail: '档内轮转' }],
  }, 7)
  assert.deepEqual(kept.audit.map(entry => entry.step), ['tier-rotate'])
})

test('服务抛错不炸穿调用方：收敛成 blocked 决策', async () => {
  const service = { resolve: async () => { throw new Error('router exploded') } }
  const outcome = await resolveTaskRoute(service, { difficulty: 'medium', role: 'general' }, 11)
  assert.equal(outcome.available, true)
  if (!outcome.available) return
  assert.equal(outcome.resolution.dispatchable, false)
  assert.equal(outcome.resolution.routeStatus, 'blocked')
  assert.equal(outcome.resolution.reason, 'router-error')
  assert.match(outcome.resolution.audit[0].detail, /router exploded/)
})

test('recordRouteEvent：服务缺席或抛错时静默跳过', () => {
  assert.doesNotThrow(() => recordRouteEvent(undefined, { type: 'dispatch' }))
  assert.doesNotThrow(() => recordRouteEvent({}, { type: 'dispatch' }))
  assert.doesNotThrow(() => recordRouteEvent({ record: () => { throw new Error('nope') } }, { type: 'dispatch' }))
  const seen = []
  recordRouteEvent({ record: (event) => seen.push(event) }, { type: 'reuse', taskId: 'k1' })
  assert.deepEqual(seen, [{ type: 'reuse', taskId: 'k1' }])
})
