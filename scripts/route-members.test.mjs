/**
 * 成员槽位归并与排队的行为测试（`planMemberSlots`）。
 *
 * 契约（不是启发式）：
 * - 同一 `memberReuseKey` 的任务共用一个成员；
 * - 不同 `memberReuseKey` 必须落在不同成员上；
 * - 达到全局 maxMembers 后，超额任务**只排队**：保留已解析的线路、写 queueReason、清掉 assignee；
 * - 队长已指定的成员优先复用。
 *
 * 注意口径：分组依据是 `memberReuseKey`（`difficulty · role · provider · model ·
 * effort` 五段），不是「同 provider/model」。两条任务解析到同一条线路但 difficulty
 * 不同，就是两个键、两个槽位 —— 难度是档内轮转的单位，槽位跟随轮转单位。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { frozenRouteOf, planMemberSlots } from '../lib/tools.js'

/** 最小 TeamState 工厂。 */
function team({ members = [], tasks = [] } = {}) {
  return {
    name: 'demo',
    id: 'demo',
    captainSessionId: 'captain-session',
    createdAt: 0,
    members: members.map((member, index) => ({
      id: member.id ?? '',
      name: member.name,
      joinedAt: index,
      status: member.status ?? 'idle',
      ...member.provider === undefined ? {} : { provider: member.provider },
      ...member.model === undefined ? {} : { model: member.model },
      ...member.routeKey === undefined ? {} : { routeKey: member.routeKey },
    })),
    tasks: tasks.map((task, index) => ({
      id: `t${index + 1}`,
      subject: `task ${index + 1}`,
      status: 'pending',
      dependencies: [],
      attempt: 0,
      difficulty: task.difficulty ?? 'medium',
      role: task.role ?? task.normalizedRole ?? 'general',
      normalizedRole: task.normalizedRole ?? 'general',
      routeStatus: 'resolved',
      resolvedRoute: task.route,
      ...task.assignee === undefined ? {} : { assignee: task.assignee },
      createdAt: index,
      updatedAt: index,
    })),
    taskSeq: tasks.length,
  }
}

const route = (model, effort = '') => ({ provider: 'p', model, reasoning_effort: effort })

test('同一 memberReuseKey 的多条任务复用同一个成员', () => {
  const fresh = team({
    tasks: [
      { route: route('a'), normalizedRole: 'engineer' },
      { route: route('a'), normalizedRole: 'engineer' },
      { route: route('a'), normalizedRole: 'engineer' },
    ],
  })
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 1, '同一复用键只应产生一个成员')
  assert.deepEqual(fresh.tasks.map(task => task.assignee), ['medium-engineer', 'medium-engineer', 'medium-engineer'])
  assert.deepEqual(fresh.tasks.map(task => task.queueReason), [undefined, undefined, undefined])
})

test('不同 memberReuseKey 必须拆分到不同成员', () => {
  const fresh = team({
    tasks: [
      { route: route('a'), normalizedRole: 'engineer' },
      { route: route('b'), normalizedRole: 'engineer' },
      { route: route('a', 'high'), normalizedRole: 'engineer' },
    ],
  })
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 3, '三个不同复用键需要三个成员')
  const names = new Set(fresh.tasks.map(task => task.assignee))
  assert.equal(names.size, 3)
  assert.equal(fresh.members.every(member => member.status === 'idle'), true)
})

test('normalizedRole 不同即不同 memberReuseKey', () => {
  const fresh = team({
    tasks: [
      { route: route('a'), normalizedRole: 'engineer' },
      { route: route('a'), normalizedRole: 'reviewer' },
    ],
  })
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 2)
})

test('difficulty 不同即不同 memberReuseKey：同线路也拆成两个槽位', () => {
  const fresh = team({
    tasks: [
      { route: route('a'), difficulty: 'medium', normalizedRole: 'general' },
      { route: route('a'), difficulty: 'high', normalizedRole: 'general' },
    ],
  })
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 2, '难度是槽位身份的一部分')
  assert.equal(fresh.members[0].routeKey.startsWith('medium\u0000'), true)
  assert.equal(fresh.members[1].routeKey.startsWith('high\u0000'), true)
})

test('队长的成员名优先复用，不会另起一个槽位', () => {
  const fresh = team({
    members: [{ name: 'alice' }],
    tasks: [
      { route: route('a'), normalizedRole: 'engineer', assignee: 'alice' },
      { route: route('a'), normalizedRole: 'engineer' },
    ],
  })
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 1, '不应新增成员')
  assert.deepEqual(fresh.tasks.map(task => task.assignee), ['alice', 'alice'])
})

test('达到 maxMembers 后超额任务只排队：保留线路、写 queueReason、清 assignee', () => {
  const fresh = team({
    tasks: [
      { route: route('a'), normalizedRole: 'engineer' },
      { route: route('b'), normalizedRole: 'engineer' },
      { route: route('c'), normalizedRole: 'engineer' },
    ],
  })
  planMemberSlots(fresh, 2)
  assert.equal(fresh.members.length, 2, '不得超过 maxMembers')
  const queued = fresh.tasks.filter(task => task.queueReason !== undefined)
  assert.equal(queued.length, 1, '恰好一条超额任务排队')
  const task = queued[0]
  assert.equal(task.assignee, undefined, '排队的任务不应挂在成员上')
  assert.match(task.queueReason, /maxMembers \(2\)/)
  assert.match(task.queueReason, /memberReuseKey/, '口径必须是 memberReuseKey，不是「同 route」')
  assert.match(task.queueReason, /不降档、不换模型/)
  // 关键：排队不改变已解析的路由
  assert.equal(task.routeStatus, 'resolved')
  assert.deepEqual(task.resolvedRoute, route('c'))
})

test('routeStatus 未 resolved 的任务不参与归并', () => {
  const fresh = team({ tasks: [{ route: route('a') }] })
  fresh.tasks[0].routeStatus = 'pending'
  delete fresh.tasks[0].resolvedRoute
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 0)
  assert.equal(fresh.tasks[0].assignee, undefined)
})

test('无已解析任务时是 no-op', () => {
  const fresh = team({ members: [{ name: 'alice' }], tasks: [] })
  planMemberSlots(fresh, 8)
  assert.deepEqual(fresh.members.map(member => member.name), ['alice'])
})

test('成员名按 difficulty-normalizedRole 生成且不冲突', () => {
  const fresh = team({
    members: [{ name: 'medium-engineer' }],
    tasks: [{ route: route('a'), normalizedRole: 'engineer' }],
  })
  // 已有同名成员但 routeKey 不同 → 新槽位必须换名
  planMemberSlots(fresh, 8)
  assert.equal(fresh.members.length, 2)
  assert.equal(fresh.members[1].name, 'medium-engineer-2')
})

test('冻结在成员上的 routeKey 与任务一致，二次归并直接复用旧成员', () => {
  const first = team({ tasks: [{ route: route('a'), normalizedRole: 'engineer' }] })
  planMemberSlots(first, 8)
  assert.equal(first.members.length, 1)
  const frozen = first.members[0]
  assert.equal(frozen.routeKey, 'medium\u0000engineer\u0000p\u0000a\u0000')
  assert.equal(typeof frozen.joinedAt, 'number')

  // 再跑一次：同一个 routeKey 必须复用而不是新增
  planMemberSlots(first, 8)
  assert.equal(first.members.length, 1)
})

test('frozenRouteOf：同一成员的多条任务线路不一致时必须报错要求拆分', () => {
  const fresh = team({
    tasks: [
      { route: route('a'), normalizedRole: 'engineer', assignee: 'alice' },
      { route: route('b'), normalizedRole: 'engineer', assignee: 'alice' },
    ],
  })
  assert.throws(() => frozenRouteOf(fresh, 'alice'), /split them across separate members/)
})

test('frozenRouteOf：一致时返回唯一线路；无任务时返回 undefined', () => {
  const fresh = team({
    tasks: [
      { route: route('a', 'high'), normalizedRole: 'engineer', assignee: 'alice' },
      { route: route('a', 'high'), normalizedRole: 'engineer', assignee: 'alice' },
    ],
  })
  assert.deepEqual(frozenRouteOf(fresh, 'alice'), {
    provider: 'p', model: 'a', reasoning_effort: 'high', difficulty: 'medium', normalizedRole: 'engineer',
  })
  assert.equal(frozenRouteOf(fresh, 'nobody'), undefined)
})
