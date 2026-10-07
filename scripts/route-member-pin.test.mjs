/**
 * 成员行「用户硬路由」（pin）的行为测试。
 *
 * 语义（用户裁定 A）：
 * - 用户在选择器里为**成员**选定模型 = 显式决定 ⇒ 记为 `routeSource: 'user'`；
 * - 该 pin **优先于**由成员任务派生出来的线路（不再被静默覆盖）；
 * - pin 当前不可派发时**阻止审批**，而不是悄悄换一条；
 * - 被 pin 的成员所服务的任务，其 `resolvedRoute` 必须与之一致（记录不得说谎）。
 *
 * 另钉住边界：无 pin 时不改动任何东西；服务缺席时不做可用性拦截，
 * 且此时任务本就没有 `routeStatus: 'resolved'`，pin 的改写自然不会触发。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { applyMemberRoutePins, revalidateMemberRoutes } from '../lib/tools.js'
import { createRoutingService } from '../../dsh-value-router/lib/index.js'

const CATALOG = {
  providers: [
    { id: 'p', catalogKnown: true, models: [{ id: 'low-model' }, { id: 'high-model' }] },
  ],
  allowlist: undefined,
  at: 0,
}

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

const config = {
  tiers: { low: { lines: [{ provider: 'p', model: 'low-model', reasoning_effort: '' }] } },
  fallback: { provider: 'p', model: 'low-model', reasoning_effort: '' },
}

function ctxWith(service) {
  return { get: (key) => (key === 'valueRouterRouting' ? service : undefined) }
}

/** 只填这两个函数会读到的字段。 */
function team({ members = [], tasks = [] } = {}) {
  return {
    name: 'demo',
    id: 'demo',
    captainSessionId: 'captain-session',
    createdAt: 0,
    members: members.map((member, index) => ({
      id: '',
      name: member.name,
      joinedAt: index,
      status: 'idle',
      ...member.provider === undefined ? {} : { provider: member.provider },
      ...member.model === undefined ? {} : { model: member.model },
      ...member.reasoningEffort === undefined ? {} : { reasoningEffort: member.reasoningEffort },
      ...member.role === undefined ? {} : { role: member.role },
      ...member.routeSource === undefined ? {} : { routeSource: member.routeSource },
    })),
    tasks: tasks.map((task, index) => ({
      id: `t${index + 1}`,
      subject: `task ${index + 1}`,
      status: 'pending',
      dependencies: [],
      attempt: 0,
      difficulty: task.difficulty ?? 'low',
      role: task.role ?? 'general',
      normalizedRole: task.normalizedRole ?? 'general',
      ...task.assignee === undefined ? {} : { assignee: task.assignee },
      ...task.routeStatus === undefined ? {} : { routeStatus: task.routeStatus },
      ...task.resolvedRoute === undefined ? {} : { resolvedRoute: task.resolvedRoute },
      ...task.routeResolvedSource === undefined ? {} : { routeResolvedSource: task.routeResolvedSource },
      ...task.routeAudit === undefined ? {} : { routeAudit: task.routeAudit },
      createdAt: index,
      updatedAt: index,
    })),
    taskSeq: tasks.length,
  }
}

const derived = { provider: 'p', model: 'low-model', reasoning_effort: '' }
const pinned = { provider: 'p', model: 'high-model', reasoning_effort: '' }

test('pin 优先于任务派生线路，并把任务记录改写成一致的线路', () => {
  const fresh = team({
    members: [{ name: 'alice', provider: 'p', model: 'high-model', routeSource: 'user' }],
    tasks: [{ assignee: 'alice', routeStatus: 'resolved', resolvedRoute: derived, routeResolvedSource: 'difficulty', routeAudit: [] }],
  })
  applyMemberRoutePins(fresh)

  const task = fresh.tasks[0]
  assert.deepEqual(task.resolvedRoute, pinned, '任务记录必须与实际执行线路一致')
  assert.equal(task.routeResolvedSource, 'user')
  assert.equal(task.routeAudit.at(-1).step, 'member-route')
  assert.equal(task.routeAudit.length, 1, '原审计链不得被抹掉')
})

test('pin 与任务派生线路一致时不写多余审计（幂等）', () => {
  const fresh = team({
    members: [{ name: 'alice', provider: 'p', model: 'low-model', routeSource: 'user' }],
    tasks: [{ assignee: 'alice', routeStatus: 'resolved', resolvedRoute: derived, routeResolvedSource: 'difficulty', routeAudit: [] }],
  })
  applyMemberRoutePins(fresh)
  assert.deepEqual(fresh.tasks[0].routeAudit, [])
  assert.equal(fresh.tasks[0].routeResolvedSource, 'difficulty')
})

test('无 pin 的成员完全不受影响', () => {
  const fresh = team({
    members: [{ name: 'alice', provider: 'p', model: 'high-model' }],
    tasks: [{ assignee: 'alice', routeStatus: 'resolved', resolvedRoute: derived, routeResolvedSource: 'difficulty', routeAudit: [] }],
  })
  applyMemberRoutePins(fresh)
  assert.deepEqual(fresh.tasks[0].resolvedRoute, derived)
  assert.deepEqual(fresh.tasks[0].routeAudit, [])
})

test('pin 落在不可派发的线路上时阻止审批', async () => {
  const service = realService(config)
  const fresh = team({
    members: [{ name: 'alice', provider: 'p', model: 'ghost-model', routeSource: 'user' }],
    tasks: [{ assignee: 'alice', routeStatus: 'resolved', resolvedRoute: derived }],
  })
  await assert.rejects(
    () => revalidateMemberRoutes(ctxWith(service), fresh),
    /plan approval blocked: user-pinned member routes are unavailable/,
  )
})

test('pin 可派发时放行', async () => {
  const service = realService(config)
  const fresh = team({
    members: [{ name: 'alice', provider: 'p', model: 'high-model', routeSource: 'user' }],
    tasks: [{ assignee: 'alice', routeStatus: 'resolved', resolvedRoute: derived }],
  })
  await revalidateMemberRoutes(ctxWith(service), fresh)
})

test('没有 pin 的成员不参与校验（含 captain 来源）', async () => {
  const service = realService(config)
  const fresh = team({
    members: [
      { name: 'bob', provider: 'p', model: 'ghost-model' },
      { name: 'carol', provider: 'p', model: 'ghost-model', routeSource: 'captain' },
    ],
  })
  await revalidateMemberRoutes(ctxWith(service), fresh)
})

test('反向证据：服务缺席时不做可用性拦截，也不改写任何任务记录', async () => {
  for (const absent of [undefined, {}, { record() {} }]) {
    // 服务缺席时 revalidateTaskRoutes 提前返回 ⇒ 任务上不会有 routeStatus，
    // 这正是真实状态：没有判据就不拦，也没有东西需要改写。
    const fresh = team({
      members: [{ name: 'alice', provider: 'p', model: 'ghost-model', routeSource: 'user' }],
      tasks: [{ assignee: 'alice' }],
    })
    await revalidateMemberRoutes(ctxWith(absent), fresh)
    applyMemberRoutePins(fresh)
    assert.equal(fresh.tasks[0].resolvedRoute, undefined, '没有解析结果就不该凭空造一个')
    assert.equal(fresh.tasks[0].routeResolvedSource, undefined)
    assert.equal(fresh.tasks[0].routeAudit, undefined)
    assert.equal(fresh.members[0].model, 'ghost-model', 'pin 本身保留，模型本来就由成员自己生效')
  }
})
