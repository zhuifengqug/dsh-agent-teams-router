/**
 * 客户端路由展示纯函数的行为测试。
 *
 * 覆盖：
 * - D.3 弹层时序常量逐字保留（100ms 停留 / 100ms 宽限）；
 * - `routeLine` 的 mono `provider/model@effort` 折叠规则。
 *
 * 2026-10-10 去路由退役：原先还测 `memberRouteKeyParts`（把成员线路键拆成
 * difficulty/role/provider/model/effort 五段）。成员不再有「线路键」——模型由
 * 用户在计划面板逐成员选定并直接冻结为 provider/model/reasoningEffort——
 * 该函数与对应组件一并删除，相关用例随之退役。
 *
 * `routeLine` 保留，因为它仍服务于**旧团队**遗留审计轨迹的只读展示。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  POPOVER_OPEN_DELAY_MS,
  POPOVER_CLOSE_DELAY_MS,
  routeLine,
} = await import('../lib/client/route-details-model.js')

test('D.3 timing constants are copied verbatim from the design ruling', () => {
  assert.equal(POPOVER_OPEN_DELAY_MS, 100)
  assert.equal(POPOVER_CLOSE_DELAY_MS, 100)
})

test('routeLine renders mono provider/model@effort and collapses empty parts', () => {
  assert.equal(routeLine('deepseek', 'deepseek-chat', 'high'), 'deepseek/deepseek-chat@high')
  assert.equal(routeLine('', 'deepseek-chat', ''), 'deepseek-chat')
  assert.equal(routeLine('deepseek', '', 'low'), 'deepseek@low')
  assert.equal(routeLine('', 'deepseek-chat', 'xhigh'), 'deepseek-chat@xhigh')
  assert.equal(routeLine('', '', ''), '')
  assert.equal(routeLine('', '', 'high'), '@high')
})

test('the retired member routeKey splitter is gone from the client helper surface', async () => {
  const helpers = await import('../lib/client/route-details-model.js')
  assert.equal(helpers.memberRouteKeyParts, undefined)
})
