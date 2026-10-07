/**
 * 组合 smoke test：Agent Teams 的桥 **真实消费** dsh-value-router 的服务。
 *
 * 这是「两者同时启用时服务闭环」的可执行证据，也是「没有 Value Router 时
 * Agent Teams 保持原行为」的反向证据：
 *
 * 1. 从 **已构建产物** 导入 dsh-value-router 的 `createRoutingService`（不是源码、
 *    不是替身），用桩 llm 提供宿主目录；
 * 2. 用 Agent Teams 真正使用的入口 `valueRouterOf` / `resolveTaskRoute` 去调用它；
 * 3. 断言四条闭环：用户硬路由胜出、队长非法路由被拒后自动重选、难度档位解析、
 *    四档全空时排队；
 * 4. 断言服务缺席时桥返回 `{available:false}`，调用方走原行为。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveTaskRoute, valueRouterOf } from '../lib/router.js'
import { createRoutingService } from '../../dsh-value-router/lib/index.js'

const CATALOG = {
  providers: [
    { id: 'p', catalogKnown: true, models: [{ id: 'low-model' }, { id: 'high-model' }] },
  ],
  allowlist: undefined,
  at: 0,
}

/** 真实服务 + 桩 llm（只实现 resolve 路径用到的方法）。 */
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
  tiers: {
    low: { lines: [{ provider: 'p', model: 'low-model', reasoning_effort: '' }] },
    high: { lines: [{ provider: 'p', model: 'high-model', reasoning_effort: '' }] },
  },
  fallback: { provider: 'p', model: 'low-model', reasoning_effort: '' },
}

test('闭环：桥能探测到真实服务，并按难度档位解析出线路', async () => {
  const service = realService(config)
  const probe = valueRouterOf({ get: (key) => (key === 'valueRouterRouting' ? service : undefined) })
  assert.equal(probe, service, 'valueRouterOf 必须认出真实服务对象')

  const outcome = await resolveTaskRoute(service, { difficulty: 'high', role: 'engineer' }, 1_000)
  assert.equal(outcome.available, true)
  assert.equal(outcome.resolution.dispatchable, true)
  assert.equal(outcome.resolution.model, 'high-model')
  assert.equal(outcome.resolution.routeSource, 'difficulty')
  assert.equal(outcome.resolution.fallback, false)
})

test('闭环：队长线路非法时只记录 route-rejected 并自动重选（任务不失败）', async () => {
  const service = realService(config)
  const outcome = await resolveTaskRoute(service, {
    difficulty: 'low',
    role: 'engineer',
    route: { provider: 'p', model: 'ghost-model', reasoning_effort: '' },
    routeSource: 'captain',
  }, 1_000)
  assert.equal(outcome.available, true)
  assert.equal(outcome.resolution.dispatchable, true, '被拒的队长线路不能弄死任务')
  assert.equal(outcome.resolution.model, 'low-model')
  assert.equal(outcome.resolution.routeSource, 'difficulty')
  assert.equal(outcome.resolution.audit.some(entry => entry.step === 'route-rejected'), true)
})

test('闭环：用户硬路由可用时胜出；不可用时挂起且不换线路、不走 fallback', async () => {
  const service = realService(config)

  const good = await resolveTaskRoute(service, {
    difficulty: 'low', role: 'engineer',
    route: { provider: 'p', model: 'high-model', reasoning_effort: '' },
    routeSource: 'user',
  }, 1_000)
  assert.equal(good.resolution.model, 'high-model', '用户硬路由优先于难度档位')
  assert.equal(good.resolution.routeSource, 'user')

  const bad = await resolveTaskRoute(service, {
    difficulty: 'low', role: 'engineer',
    route: { provider: 'p', model: 'ghost-model', reasoning_effort: '' },
    routeSource: 'user',
  }, 1_000)
  assert.equal(bad.resolution.dispatchable, false, '用户硬路由不可用必须挂起')
  assert.equal(bad.resolution.routeStatus, 'pending')
  assert.equal(bad.resolution.fallback, false)
  assert.equal(bad.resolution.provider, '', '不得替用户换一条线路')
})

test('闭环：四档全空且无 fallback 时排队，桥把 queueReason 传给调用方', async () => {
  const service = realService({ tiers: {}, fallback: undefined })
  const outcome = await resolveTaskRoute(service, { difficulty: 'medium', role: 'general' }, 1_000)
  assert.equal(outcome.available, true)
  assert.equal(outcome.resolution.dispatchable, false)
  assert.equal(outcome.resolution.routeStatus, 'pending')
  assert.equal(outcome.resolution.reason, 'no-route')
})

test('闭环：服务侧审计被真实写入（resolve 自动落一条事件）', async () => {
  const service = realService(config)
  await resolveTaskRoute(service, { difficulty: 'low', role: 'engineer', teamId: 'demo', taskId: 't1' }, 1_000)
  const events = service.events()
  assert.equal(events.length, 1)
  assert.equal(events[0].teamId, 'demo')
  assert.equal(events[0].taskId, 't1')
  assert.equal(events[0].type, 'dispatch')
})

test('反向证据：Value Router 缺席时桥返回 {available:false}，调用方保持原行为', async () => {
  for (const absent of [undefined, {}, { record() {} }]) {
    const outcome = await resolveTaskRoute(absent, { difficulty: 'low', role: 'general' })
    assert.deepEqual(outcome, { available: false }, '缺席必须显式表达，不得发明替身')
  }
})
