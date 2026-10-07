/**
 * 调度就绪判定里的路由守卫（`nextReadyTask`）。
 *
 * 背景：`nextReadyTask` 的兜底分支是 `ready.find(task => task.assignee === undefined)`
 * —— 任何**无 assignee 的 pending 任务**都会被任意空闲成员领走。这对
 * `maxMembers` 超额排队是设计内的「有人空出来就接」，但对**路由未解析**的任务
 * （Value Router 判成 pending/blocked、没有 `resolvedRoute`、`planMemberSlots`
 * 因此不给它挂成员）是个洞：它会被领走并按**该成员自己的冻结模型**执行，与
 * `revalidateTaskRoutes` 文档的 "never silently given a different model" 冲突。
 *
 * 守卫必须**窄**：只排除「路由已显式判定为不可派发」的任务，
 * 保留 maxMembers 排队语义，并让未接入 Value Router 的团队行为完全不变。
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

test('路由已判不可派发的任务不会被任何空闲成员领走（本次修复）', () => {
  for (const routeStatus of ['pending', 'blocked']) {
    const tasks = [task('t1', { routeStatus })]
    assert.equal(nextReadyTask(tasks, 'alice'), undefined, `routeStatus=${routeStatus} 必须不可派发`)
  }
})

test('路由已判不可派发时，即使被显式挂到该成员也不派发', () => {
  const tasks = [task('t1', { routeStatus: 'blocked', assignee: 'alice' })]
  assert.equal(nextReadyTask(tasks, 'alice'), undefined)
})

test('maxMembers 排队语义保持：已解析但无 assignee 的任务仍可被领走', () => {
  const tasks = [task('t1', { routeStatus: 'resolved' })]
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't1')
})

test('反向证据：未接入 Value Router 的团队（无 routeStatus）行为不变', () => {
  const tasks = [task('t1')]
  assert.equal(tasks[0].routeStatus, undefined)
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't1', '基础共享任务池语义不得被改动')
})

test('已指派给本成员的任务优先于共享池', () => {
  const tasks = [
    task('t1', { routeStatus: 'resolved' }),
    task('t2', { routeStatus: 'resolved', assignee: 'alice' }),
  ]
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't2')
})

test('依赖未满足仍然拦截，且守卫不改变既有依赖语义', () => {
  const tasks = [
    task('t1', { status: 'in_progress' }),
    task('t2', { routeStatus: 'resolved', dependencies: ['t1'] }),
  ]
  assert.equal(nextReadyTask(tasks, 'alice'), undefined)
})

test('被守卫挡下时不会顺带放行另一条不可派发任务', () => {
  const tasks = [
    task('t1', { routeStatus: 'pending' }),
    task('t2', { routeStatus: 'blocked' }),
    task('t3', { routeStatus: 'resolved' }),
  ]
  assert.equal(nextReadyTask(tasks, 'alice')?.id, 't3', '只有已解析的那条可以被领走')
})
