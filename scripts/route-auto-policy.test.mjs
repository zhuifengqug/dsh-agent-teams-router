/**
 * 自动创建路径的任务级路由策略（`revalidateTaskRoutes` 的 `userRouteUnavailable`）。
 *
 * 背景：`agent_teams_create` 的 `approval` **缺省就是 automatic**。而 staged 路径
 * 只在审批时刻调用 `revalidateTaskRoutes`，所以自动路径过去完全不做任务级路由，
 * 成员会退回 profile 默认模型。修法是在 `initializeProfileTeam` 的非 staged 分支
 * 里也解析一次；但自动路径没有审批时刻、没有人可以补救，所以不可用的**用户**硬
 * 路由不能像 staged 那样把整次创建弄失败——改为该任务保持不可派发并记入审计。
 *
 * 本测试用**已构建的真实服务**（dsh-value-router 的 `createRoutingService`，不是替身）
 * 钉住两条策略的语义差异，以及「策略只影响 user 分支」这条边界。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { planMemberSlots, revalidateTaskRoutes } from '../lib/tools.js'
import { createRoutingService } from '../../dsh-value-router/lib/index.js'

const CATALOG = {
  providers: [
    { id: 'p', catalogKnown: true, models: [{ id: 'low-model' }, { id: 'high-model' }] },
  ],
  allowlist: undefined,
  at: 0,
}

/** 真实服务 + 桩 llm（只实现解析路径用到的方法）。 */
function realService(config) {
  return createRoutingService({
    getConfig: () => config,
    llm: () => ({
      listProviders: () => CATALOG.providers.map(provider => ({ id: provider.id, name: provider.id })),
      listModels: async (provider) => CATALOG.providers.find(item => item.id === provider)?.models ?? [],
      resolveModelInfo: async (provider, model) => ({ provider, id: model, name: model }),
    }),
    readAllowlist: () => undefined,
    now: () => 1_000,
  })
}

/** 只要一档可用即可；不可用的用户硬路由不会碰它。 */
const config = {
  tiers: { low: { lines: [{ provider: 'p', model: 'low-model', reasoning_effort: '' }] } },
  fallback: { provider: 'p', model: 'low-model', reasoning_effort: '' },
}

/** 只暴露 `get('valueRouterRouting')` —— 与 `valueRouterOf` 的探测面一致。 */
function ctxWith(service) {
  return { get: (key) => (key === 'valueRouterRouting' ? service : undefined) }
}

/** 最小 TeamState 工厂：只填 `revalidateTaskRoutes` 与 `planMemberSlots` 会读的字段。 */
function team(tasks) {
  return {
    name: 'demo',
    id: 'demo',
    captainSessionId: 'captain-session',
    createdAt: 0,
    members: [],
    tasks: tasks.map((task, index) => ({
      id: `t${index + 1}`,
      subject: `task ${index + 1}`,
      status: 'pending',
      dependencies: [],
      attempt: 0,
      difficulty: task.difficulty ?? 'low',
      role: task.role ?? 'general',
      normalizedRole: task.normalizedRole ?? 'general',
      ...task.route === undefined ? {} : { route: task.route, routeSource: task.routeSource ?? 'captain' },
      createdAt: index,
      updatedAt: index,
    })),
    taskSeq: tasks.length,
  }
}

const ghost = { provider: 'p', model: 'ghost-model', reasoning_effort: '' }

test('queue 策略：用户硬路由不可用不抛错，任务保持不可派发且记入审计', async () => {
  const service = realService(config)
  const fresh = team([{ route: ghost, routeSource: 'user', role: 'engineer' }])

  await revalidateTaskRoutes(ctxWith(service), fresh, { userRouteUnavailable: 'queue' })

  const task = fresh.tasks[0]
  assert.equal(task.resolvedRoute, undefined, '不得替用户选一条线路')
  assert.notEqual(task.routeStatus, 'resolved')
  // 审计必须留下可追溯的一条
  const queued = service.events().filter(event => event.type === 'queue')
  assert.equal(queued.length, 1, '必须落一条 queue 事件')
  assert.equal(queued[0].taskId, 't1')
  assert.equal(typeof queued[0].queueReason, 'string')
  assert.notEqual(queued[0].queueReason, '')
})

test('默认策略（block-approval）：同一输入必须阻止审批', async () => {
  const service = realService(config)
  const fresh = team([{ route: ghost, routeSource: 'user', role: 'engineer' }])

  await assert.rejects(
    () => revalidateTaskRoutes(ctxWith(service), fresh),
    /plan approval blocked/,
    'staged 路径的行为不得被本次改动改变',
  )
  assert.equal(fresh.tasks[0].resolvedRoute, undefined)
})

test('queue 策略只影响 user 分支：队长非法线路仍然自动重选', async () => {
  const service = realService(config)
  const fresh = team([{ route: ghost, routeSource: 'captain', role: 'engineer' }])

  await revalidateTaskRoutes(ctxWith(service), fresh, { userRouteUnavailable: 'queue' })

  const task = fresh.tasks[0]
  assert.equal(task.routeStatus, 'resolved', '被拒的队长线路不能弄死任务')
  assert.equal(task.resolvedRoute.model, 'low-model')
  assert.equal(task.routeResolvedSource, 'difficulty')
  assert.equal(task.routeAudit.some(entry => entry.step === 'route-rejected'), true)
})

test('queue 策略下可解析的任务照常解析出线路', async () => {
  const service = realService(config)
  const fresh = team([{ role: 'engineer' }])

  await revalidateTaskRoutes(ctxWith(service), fresh, { userRouteUnavailable: 'queue' })

  const task = fresh.tasks[0]
  assert.equal(task.routeStatus, 'resolved')
  assert.deepEqual(task.resolvedRoute, { provider: 'p', model: 'low-model', reasoning_effort: '' })
  assert.equal(task.routeResolvedSource, 'difficulty')
})

test('不可派发的任务不会被挂到任何成员上（自动路径的排队语义）', async () => {
  const service = realService({ tiers: {}, fallback: undefined })
  const fresh = team([{ role: 'engineer' }, { role: 'engineer' }])

  await revalidateTaskRoutes(ctxWith(service), fresh, { userRouteUnavailable: 'queue' })
  planMemberSlots(fresh, 8)

  assert.equal(fresh.members.length, 0, '无从解析就不该造成员')
  assert.deepEqual(fresh.tasks.map(task => task.assignee), [undefined, undefined])
})

test('反向证据：服务缺席时两条策略都立即返回，不写任何路由字段', async () => {
  for (const absent of [undefined, {}, { record() {} }]) {
    for (const policy of ['block-approval', 'queue']) {
      const fresh = team([{ route: ghost, routeSource: 'user', role: 'engineer' }])
      await revalidateTaskRoutes(ctxWith(absent), fresh, { userRouteUnavailable: policy })
      const task = fresh.tasks[0]
      assert.equal(task.routeStatus, undefined, '服务缺席时不得凭空写路由状态')
      assert.equal(task.resolvedRoute, undefined)
      assert.equal(task.routeAudit, undefined)
    }
  }
})
