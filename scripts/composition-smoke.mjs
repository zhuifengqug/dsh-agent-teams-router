/**
 * 组合 smoke（Agent Teams 插件侧）：**没有任何外部路由依赖**也能正常装配。
 *
 * ## 2026-10-10 去路由退役（本文件重写）
 *
 * 本文件原名「组合 smoke test：Agent Teams 的桥**真实消费** dsh-value-router 的服务」。
 * 它从已构建产物导入 dsh-value-router 的 `createRoutingService`，再用 Agent Teams 真正
 * 使用的入口 `valueRouterOf` / `resolveTaskRoute` 去调用它，钉住四条闭环（用户硬路由
 * 胜出、队长非法路由被拒后自动重选、难度档位解析、四档全空时排队），外加「服务缺席时
 * 桥返回 `{available:false}`」的反向证据。
 *
 * 用户裁决把「任务难度 → 外部路由服务自动决定成员模型」整套机制退役后：
 * - `VALUE_ROUTER_SERVICE_KEY` / `valueRouterOf` / `resolveTaskRoute` /
 *   `coerceResolution` / `recordRouteEvent` 已从 `src/router.ts` 删除；
 * - 该组合所依赖的 `dsh-value-router` 也已不在本机插件目录中；
 * - 因此**原文件的 6 个用例全部失去可测对象**，整体替换为本文件。
 *
 * ## 现在钉住的契约
 *
 * Agent Teams 不再依赖任何外部路由服务，所以「组合」的含义变成：**在没有路由服务、
 * 没有任何 provider 目录**的前提下，插件自身的公开面仍然自洽可用——
 * 1. 模块入口能加载，且**不再导出**任何路由桥符号（退役被回退会立刻失败）；
 * 2. 难度/角色字段照常可校验，且只产出展示三字段；
 * 3. 任务展示编辑（`applyTaskPresentationEdit`）只写难度/角色，**不残留**任何 route 字段；
 * 4. 调度判定不看遗留 route 字段，pending + 依赖满足即可派发。
 *
 * 这个文件不再 import dsh-value-router，也不再需要桩服务。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { nextReadyTask } from '../lib/scheduler.js'
import { applyTaskPresentationEdit, taskPresentationEditFrom } from '../lib/tools.js'

const router = await import('../lib/router.js')
const tools = await import('../lib/tools.js')

/** 最小 TeamTask 工厂：只填调度判定会读的字段。 */
function task(id, fields = {}) {
  return {
    id,
    subject: `task ${id}`,
    status: fields.status ?? 'pending',
    dependencies: fields.dependencies ?? [],
    attempt: 0,
    ...fields.assignee === undefined ? {} : { assignee: fields.assignee },
    ...fields.routeStatus === undefined ? {} : { routeStatus: fields.routeStatus },
  }
}

test('退役面：router/tools 不再导出任何路由桥符号', () => {
  for (const retired of [
    'VALUE_ROUTER_SERVICE_KEY',
    'valueRouterOf',
    'resolveTaskRoute',
    'recordRouteEvent',
    'coerceResolution',
    'memberReuseKey',
  ]) {
    assert.equal(router[retired], undefined, `router.js must not export the retired ${retired}`)
  }
  for (const retired of [
    'revalidateTaskRoutes',
    'planMemberSlots',
    'revalidateMemberRoutes',
    'applyMemberRoutePins',
    'frozenRouteOf',
  ]) {
    assert.equal(tools[retired], undefined, `tools.js must not export the retired ${retired}`)
  }
})

test('组合可加载：难度/角色校验照常工作，且只产出展示三字段', () => {
  const result = router.validateTaskRouteFields({ difficulty: 'high', role: ' Reviewer ' })
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.deepEqual(Object.keys(result.fields).sort(), ['difficulty', 'normalizedRole', 'role'])
  assert.equal(result.fields.normalizedRole, 'reviewer')

  const defaults = router.validateTaskRouteFields({})
  assert.equal(defaults.ok, true)
  if (!defaults.ok) return
  assert.equal(defaults.fields.difficulty, 'medium')
  assert.equal(defaults.fields.role, 'general')
})

test('组合可加载：任务展示编辑只写难度/角色，不残留任何 route 字段', () => {
  const fresh = {}
  applyTaskPresentationEdit(fresh, { difficulty: 'max', role: '  Code   Reviewer ' })
  assert.deepEqual(Object.keys(fresh).sort(), ['difficulty', 'normalizedRole', 'role'])
  assert.equal(fresh.difficulty, 'max')
  assert.equal(fresh.role, 'Code   Reviewer')
  assert.equal(fresh.normalizedRole, 'code reviewer')

  // 旧记录上的遗留键保持原样（读旧团队时不改写、也不新增）。
  const legacy = {
    id: 't1',
    route: { provider: 'p', model: 'm' },
    resolvedRoute: { provider: 'p', model: 'm' },
    routeStatus: 'resolved',
    routeSource: 'user',
    routeResolvedSource: 'difficulty',
    routeAudit: [{ step: 'validate' }],
  }
  applyTaskPresentationEdit(legacy, { difficulty: 'low', role: 'engineer' })
  assert.equal(legacy.routeStatus, 'resolved', '遗留键不得被改写')
  assert.deepEqual(legacy.route, { provider: 'p', model: 'm' })
  assert.equal(legacy.difficulty, 'low')

  // 非法值必须报错，不得静默回落。
  assert.throws(() => applyTaskPresentationEdit({}, { difficulty: 'urgent' }), /invalid difficulty/)
})

test('组合可加载：队长操作的展示编辑只看 difficulty/role，忽略已退役的线路参数', () => {
  assert.deepEqual(taskPresentationEditFrom({ task_difficulty: 'high', task_role: 'Rev' }), {
    difficulty: 'high',
    role: 'Rev',
  })
  assert.deepEqual(
    taskPresentationEditFrom({ task_provider: 'p', task_model: 'm', task_reasoning_effort: 'high' }),
    {},
    '已退役的 task_provider/task_model/task_reasoning_effort 必须被忽略',
  )
  assert.deepEqual(taskPresentationEditFrom({}), {})
})

test('组合可加载：调度判定不看遗留 route 字段（无路由服务也能派发）', () => {
  assert.equal(nextReadyTask([task('t1', { routeStatus: 'pending' })], 'alice')?.id, 't1')
  assert.equal(nextReadyTask([task('t2', { routeStatus: 'blocked' })], 'alice')?.id, 't2')
  assert.equal(nextReadyTask([task('t3')], 'alice')?.id, 't3')
  // 依赖未满足仍然拦截。
  assert.equal(
    nextReadyTask([task('t4', { status: 'in_progress' }), task('t5', { dependencies: ['t4'] })], 'alice'),
    undefined,
  )
})
