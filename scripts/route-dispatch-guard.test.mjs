/**
 * 调度就绪判定里的**遗留 route 字段容忍**（`nextReadyTask`）。
 *
 * ## 2026-10-10 去路由退役（本文件重写）
 *
 * 本文件原先钉的是一个叫「路由派发守卫」的契约：`nextReadyTask` 里有一处
 * `routeBlocksDispatch`，把「Value Router 已显式判定为不可派发」
 * （`routeStatus: 'pending' | 'blocked'`）的任务从就绪集合里排除，理由是那种任务
 * 当时没有 `resolvedRoute`、`planMemberSlots` 也不给它挂成员，若不拦就会被任意
 * 空闲成员领走并按该成员自己的冻结模型执行。
 *
 * 该守卫随整套「难度 → 外部路由服务决定成员模型」机制一起**退役**：
 * 任务不再携带自己的线路，成员模型由用户在计划面板逐成员选定并在创建时冻结。
 * 「路由未解析所以不能派发」这个状态**不再存在**，守卫本身已从 `src/scheduler.ts`
 * 删除——所以下面这组断言**不再是回归防护，而是新契约的钉子**。
 *
 * ## 现在钉住的契约
 *
 * 1. `nextReadyTask` **不看** `routeStatus`（它已经不是调度判据）。带着遗留
 *    `routeStatus: 'pending' | 'blocked'` 的旧记录，只要 status=pending、
 *    依赖满足、未 reassigning，就照常可派发——无论是否已挂给该成员；
 * 2. 派发的**唯一**判据仍是既有的三条：pending、依赖满足、未 reassigning；
 * 3. maxMembers 排队语义不变：无 assignee 的任务可被任意空闲成员领走；
 * 4. 已指派给本成员的任务优先于共享池；挂给别人且不满足前两条时不派发。
 *
 * 旧的 `routeBlocksDispatch` 守卫若被重新引入，第 1、2 组断言会立即失败。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { nextReadyTask } from '../lib/scheduler.js'

/** 最小 TeamTask 工厂：只填调度判定会读的字段。 */
function task(id, fields = {}) {
  return {
    id,
    subject: `task ${id}`,
    status: fields.status ?? 'pending',
    dependencies: fields.dependencies ?? [],
    attempt: 0,
    ...fields.reassigning === undefined ? {} : { reassigning: fields.reassigning },
    ...fields.assignee === undefined ? {} : { assignee: fields.assignee },
    ...fields.routeStatus === undefined ? {} : { routeStatus: fields.routeStatus },
  }
}

test('遗留 routeStatus 不再是调度判据：pending / blocked 的旧记录照常可派发（去路由）', () => {
  for (const routeStatus of ['pending', 'blocked']) {
    const tasks = [task('t1', { routeStatus })]
    assert.equal(
      nextReadyTask(tasks, 'alice')?.id,
      't1',
      `routeStatus=${routeStatus} 已不参与派发判定，不得再被拦下`,
    )
  }
})

test('遗留 routeStatus 不是判据：即使被显式挂到该成员也可派发', () => {
  const tasks = [task('t1', { routeStatus: 'blocked', assignee: 'alice' })]
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't1')
})

test('派发的唯一判据是 pending + 依赖满足 + 未 reassigning', () => {
  // 三条判据各自独立生效，且与 routeStatus 无关。
  assert.equal(nextReadyTask([task('t1', { routeStatus: 'pending', reassigning: true })], 'alice'), undefined)
  assert.equal(nextReadyTask([task('t1', { routeStatus: 'pending', status: 'completed' })], 'alice'), undefined)
  assert.equal(
    nextReadyTask([task('t1', { status: 'in_progress' }), task('t2', { routeStatus: 'pending', dependencies: ['t1'] })], 'alice'),
    undefined,
  )
})

test('maxMembers 排队语义保持：带遗留字段但无 assignee 的任务仍可被任意空闲成员领走', () => {
  const tasks = [task('t1', { routeStatus: 'resolved' })]
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't1')
  // 无遗留字段的基础共享任务池语义不得被改动。
  const plain = [task('t2')]
  assert.equal(plain[0].routeStatus, undefined)
  assert.equal(nextReadyTask(plain, 'alice')?.id, 't2')
})

test('已指派给本成员的任务优先于共享池', () => {
  const tasks = [
    task('t1', { routeStatus: 'resolved' }),
    task('t2', { routeStatus: 'resolved', assignee: 'alice' }),
  ]
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't2')
})

test('挂给别人的任务不派发；全部带遗留字段时仍按顺序取第一条就绪任务', () => {
  assert.equal(nextReadyTask([task('t1', { assignee: 'bob' })], 'alice'), undefined)
  const tasks = [
    task('t1', { routeStatus: 'pending' }),
    task('t2', { routeStatus: 'blocked' }),
    task('t3', { routeStatus: 'resolved' }),
  ]
  assert.equal(
    nextReadyTask(tasks, 'alice')?.id,
    't1',
    '三条都就绪 → 取第一条；守卫退役后不得再只放行 routeStatus=resolved 的那条',
  )
})
