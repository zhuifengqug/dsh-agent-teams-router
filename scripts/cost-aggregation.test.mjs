/**
 * 步 6（C.1 数据层）：团队级成本聚合的行为测试。
 *
 * 覆盖：
 * - 来源缺席 → 明确 no-data 状态，绝无 totals/members/任何数字（无数据 ≠ 零）；
 * - cost-meter 服务路径：团队合计 + 成员分列，每个数字带来源标注；
 * - found=false / 形状不认识 / 成员无会话 id → 该成员无读数（≠ 0）；
 * - 真实零用量（found=true 全零桶）→ 读数为 0 且带来源（与 no-data 区分）；
 * - 单会话读数抛错只让该成员缺数据，不炸快照（允许的 catch = 调用期失败隔离）；
 * - 委托子会话（subagentCount>0）并入成员读数并标注 attributedSubsessions；
 * - 投影回落路径：costUsage 优先（含 cost），tokenUsage 兜底（无 cost，绝不估算）；
 * - 来源优先级：costMeter 服务在场时投影 seam 不参与；
 * - 快照装配层：cost 字段落位 + 既有字段投影无回归；
 * - 快照边界 guard：合法形状通过、坏形状拒绝；
 * - payload 尺寸：8 成员典型形状 ≤ 4KB。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  COST_METER_SERVICE_KEY,
  COST_USAGE_PROJECTION_KEY,
  SESSION_PROJECTIONS_SERVICE_KEY,
  TOKEN_USAGE_PROJECTION_KEY,
  assembleTeamCost,
  costSourceOf,
  isTeamCostSummary,
} from '../lib/cost.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'

/** 深度收集一个值里的全部数字（用于断言「没有任何数字」）。 */
function numbersOf(value) {
  const found = []
  const walk = (node) => {
    if (typeof node === 'number') { found.push(node); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (node !== null && typeof node === 'object') Object.values(node).forEach(walk)
  }
  walk(value)
  return found
}

/** 构造一个成员（成本聚合只读 id/name）。 */
function member(overrides = {}) {
  return { id: 'session-a', name: 'engineer-1', joinedAt: 1, status: 'idle', ...overrides }
}

/** 构造一个 cost-meter 服务 stub。 */
function costMeterStub(perSession) {
  return { getSessionCost: async (sessionId) => perSession(sessionId) }
}

/** 构造一个投影 seam 上下文 stub（costMeter 缺席，seam 在场；live 会话按 id 区分 seq）。 */
function seamCtx({ values, liveIds = ['session-a'] }) {
  return {
    get: (key) => {
      if (key === COST_METER_SERVICE_KEY) return undefined
      if (key === SESSION_PROJECTIONS_SERVICE_KEY) {
        return { snapshot: (session, keys) => {
          assert.deepEqual(keys, [COST_USAGE_PROJECTION_KEY, TOKEN_USAGE_PROJECTION_KEY])
          return { asOfSeq: 5, values: values(session, keys) }
        } }
      }
      return undefined
    },
    agents: {
      get: (id) => {
        const key = String(id)
        return liveIds.includes(key) ? { session: { seq: liveIds.indexOf(key) } } : undefined
      },
    },
  }
}

// ── 探测 ──

test('costSourceOf：ctx 缺席/无 get → 全缺席并列出探测过的服务键', () => {
  assert.deepEqual(costSourceOf(undefined), { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] })
  assert.deepEqual(costSourceOf({}), { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] })
  assert.deepEqual(costSourceOf({ get: () => undefined }), { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] })
})

test('costSourceOf：costMeter 服务在场（getSessionCost 是函数）→ 服务句柄', () => {
  const outcome = costSourceOf({ get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub(() => ({})) : undefined })
  assert.equal(outcome.available, true)
  assert.equal(outcome.kind, 'cost-meter:service')
  assert.equal(typeof outcome.getSessionCost, 'function')
})

test('costSourceOf：getSessionCost 缺失/非函数 → 视为版本不认识，回落 seam 或缺席', () => {
  assert.deepEqual(costSourceOf({ get: (key) => key === COST_METER_SERVICE_KEY ? {} : undefined }), { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] })
  assert.deepEqual(costSourceOf({ get: (key) => key === COST_METER_SERVICE_KEY ? { getSessionCost: 42 } : undefined }), { available: false, missing: [COST_METER_SERVICE_KEY, SESSION_PROJECTIONS_SERVICE_KEY] })
  const outcome = costSourceOf({ get: (key) => key === SESSION_PROJECTIONS_SERVICE_KEY ? { snapshot: () => undefined } : undefined })
  assert.equal(outcome.available, true)
  assert.equal(outcome.kind, 'projection-seam')
  assert.equal(typeof outcome.snapshot, 'function')
  assert.equal(typeof outcome.getAgent, 'function')
})

// ── 来源缺席 → no-data（无数据 ≠ 零） ──

test('来源缺席：明确 no-data，绝无 totals/members/source/任何数字', async () => {
  for (const ctx of [undefined, {}, { get: () => undefined }]) {
    const summary = await assembleTeamCost(ctx, [member()])
    assert.equal(summary.status, 'no-data')
    assert.ok(typeof summary.reason === 'string' && summary.reason.length > 0, 'no-data must carry a reason')
    assert.equal(summary.source, undefined)
    assert.equal(summary.totals, undefined)
    assert.equal(summary.members, undefined)
    assert.deepEqual(numbersOf(summary), [], 'no-data must not contain any number (zero is not allowed)')
  }
})

test('花名册为空：no-data（团队还没有成员会话）', async () => {
  const summary = await assembleTeamCost({ get: () => undefined }, [])
  assert.equal(summary.status, 'no-data')
  assert.deepEqual(numbersOf(summary), [])
})

test('cost-meter 在场但全部成员 found=false：no-data 且无数字', async () => {
  let called = 0
  const ctx = { get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub(() => { called += 1; return { found: false } }) : undefined }
  const summary = await assembleTeamCost(ctx, [member(), member({ id: 'session-b', name: 'researcher-1' })])
  assert.equal(summary.status, 'no-data')
  assert.ok(called >= 2, 'each member session must be read')
  assert.deepEqual(numbersOf(summary), [])
})

test('成员无会话 id（staged 未派生）：不调用来源，no-data', async () => {
  let called = 0
  const ctx = { get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub(() => { called += 1; return { found: true, own: { input: 1 } } }) : undefined }
  const summary = await assembleTeamCost(ctx, [member({ id: '' })])
  assert.equal(summary.status, 'no-data')
  assert.equal(called, 0, 'a member without a session id must not hit the source')
  assert.deepEqual(numbersOf(summary), [])
})

// ── cost-meter 服务路径 ──

test('cost-meter 服务：团队合计 + 成员分列，每个数字带来源标注', async () => {
  const ledger = {
    'session-a': { found: true, own: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, reasoning: 30, calls: 3, cost: 0.02, apiCost: 0.015 }, subagents: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, apiCost: 0 }, subagentCount: 0 },
    'session-b': { found: true, own: { input: 40, output: 20, cost: 0.004, apiCost: 0.004 } },
    'session-c': { found: false },
  }
  const ctx = { get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub((id) => ledger[id]) : undefined }
  const summary = await assembleTeamCost(ctx, [
    member({ id: 'session-a', name: 'engineer-1' }),
    member({ id: 'session-b', name: 'researcher-1' }),
    member({ id: 'session-c', name: 'reviewer-1' }),
  ])
  assert.equal(summary.status, 'ok')
  assert.equal(summary.source, 'cost-meter:service')
  // 成员分列
  const a = summary.members[0]
  assert.deepEqual(a.reading.inputTokens, { value: 100, source: 'cost-meter:service' })
  assert.deepEqual(a.reading.outputTokens, { value: 50, source: 'cost-meter:service' })
  assert.deepEqual(a.reading.cacheReadTokens, { value: 200, source: 'cost-meter:service' })
  assert.deepEqual(a.reading.cacheWriteTokens, { value: 10, source: 'cost-meter:service' })
  assert.deepEqual(a.reading.costEstimate, { value: 0.02, source: 'cost-meter:service' })
  // 每个数字都带来源标注
  for (const row of summary.members) {
    for (const metric of Object.values(row.reading ?? {})) {
      assert.ok(metric !== undefined && typeof metric.source === 'string' && metric.source.length > 0)
    }
  }
  // found=false 成员无读数（≠ 0）
  assert.equal(summary.members[2].memberId, 'session-c')
  assert.equal(summary.members[2].reading, undefined)
  // 合计只对成员真正报出的桶求和；成员 B 未报 cacheRead → 合计只来自 A（200），不出现 0 充数
  assert.deepEqual(summary.totals.inputTokens, { value: 140, source: 'cost-meter:service' })
  assert.deepEqual(summary.totals.outputTokens, { value: 70, source: 'cost-meter:service' })
  assert.deepEqual(summary.totals.cacheReadTokens, { value: 200, source: 'cost-meter:service' })
  assert.deepEqual(summary.totals.cacheWriteTokens, { value: 10, source: 'cost-meter:service' })
  assert.deepEqual(summary.totals.costEstimate, { value: 0.024, source: 'cost-meter:service' })
})

test('真实零用量：found=true 全零桶是带来源的读数，不是 no-data', async () => {
  const ctx = { get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub(() => ({ found: true, own: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, calls: 0, cost: 0, apiCost: 0 } })) : undefined }
  const summary = await assembleTeamCost(ctx, [member()])
  assert.equal(summary.status, 'ok')
  const reading = summary.members[0].reading
  assert.equal(reading.inputTokens.value, 0)
  assert.equal(reading.inputTokens.source, 'cost-meter:service')
  assert.equal(reading.costEstimate.value, 0)
})

test('单会话读数抛错只让该成员缺数据，快照不炸', async () => {
  const ctx = {
    get: (key) => key === COST_METER_SERVICE_KEY
      ? { getSessionCost: async (id) => {
        if (id === 'session-a') throw new Error('ledger locked')
        return { found: true, own: { input: 7, cost: 0.001 } }
      } }
      : undefined,
  }
  const summary = await assembleTeamCost(ctx, [member({ id: 'session-a' }), member({ id: 'session-b', name: 'researcher-1' })])
  assert.equal(summary.status, 'ok')
  assert.equal(summary.members[0].reading, undefined)
  assert.deepEqual(summary.totals.inputTokens, { value: 7, source: 'cost-meter:service' })
})

test('跨版本形状漂移：桶字段非有限非负数 → 该成员无读数，不输出 0 也不炸', async () => {
  const ctx = { get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub(() => ({ found: true, own: { input: 'many', output: Number.NaN, cost: -1 } })) : undefined }
  const summary = await assembleTeamCost(ctx, [member()])
  assert.equal(summary.status, 'no-data')
  assert.deepEqual(numbersOf(summary), [])
})

test('委托子会话并入成员读数并标注 attributedSubsessions', async () => {
  const row = { found: true, own: { input: 100, output: 50, cost: 0.01 }, subagents: { input: 30, output: 10, cost: 0.003 }, subagentCount: 2 }
  const ctx = { get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub(() => row) : undefined }
  const summary = await assembleTeamCost(ctx, [member()])
  assert.equal(summary.members[0].attributedSubsessions, 2)
  assert.deepEqual(summary.members[0].reading.inputTokens, { value: 130, source: 'cost-meter:service' })
  assert.deepEqual(summary.totals.inputTokens, { value: 130, source: 'cost-meter:service' })
  assert.deepEqual(summary.totals.outputTokens, { value: 60, source: 'cost-meter:service' })
})

test('来源优先级：costMeter 服务在场时投影 seam 不参与', async () => {
  const ctx = {
    get: (key) => {
      if (key === COST_METER_SERVICE_KEY) return costMeterStub(() => ({ found: true, own: { input: 1 } }))
      if (key === SESSION_PROJECTIONS_SERVICE_KEY) return { snapshot: () => { throw new Error('must not be called when the cost-meter service is present') } }
      return undefined
    },
  }
  const summary = await assembleTeamCost(ctx, [member()])
  assert.equal(summary.source, 'cost-meter:service')
  assert.deepEqual(summary.totals.inputTokens, { value: 1, source: 'cost-meter:service' })
})

// ── 投影回落路径 ──

test('投影回落：costUsage 视图优先，费用桶来自 costUsage（不估算）', async () => {
  const ctx = seamCtx({ values: () => ({ costUsage: { input: 10, output: 4, cacheRead: 20, cacheWrite: 2, reasoning: 1, cost: 0.001, byModel: {} } }) })
  const summary = await assembleTeamCost(ctx, [member({ id: 'session-a' }), member({ id: 'session-b', name: 'researcher-1' })])
  assert.equal(summary.status, 'ok')
  assert.equal(summary.source, 'projection:costUsage')
  const a = summary.members[0]
  assert.deepEqual(a.reading.inputTokens, { value: 10, source: 'projection:costUsage' })
  assert.deepEqual(a.reading.outputTokens, { value: 4, source: 'projection:costUsage' })
  assert.deepEqual(a.reading.costEstimate, { value: 0.001, source: 'projection:costUsage' })
  // session-b 未附加（agents.get undefined）→ 无读数（≠ 0）
  assert.equal(summary.members[1].reading, undefined)
  assert.deepEqual(summary.totals.inputTokens, { value: 10, source: 'projection:costUsage' })
})

test('投影回落：只有 tokenUsage 时费用桶缺席（绝不从 token 估算费用）', async () => {
  const ctx = seamCtx({ values: () => ({ tokenUsage: { uncachedInputTokens: 10, outputTokens: 4, cacheReadTokens: 20, cacheWriteTokens: 2 } }) })
  const summary = await assembleTeamCost(ctx, [member()])
  assert.equal(summary.source, 'projection:tokenUsage')
  assert.deepEqual(summary.members[0].reading.inputTokens, { value: 10, source: 'projection:tokenUsage' })
  assert.deepEqual(summary.members[0].reading.cacheReadTokens, { value: 20, source: 'projection:tokenUsage' })
  assert.equal(summary.members[0].reading.costEstimate, undefined)
  assert.equal(summary.totals.costEstimate, undefined)
})

test('投影回落：混合视图逐成员落实，合计取首个贡献者来源', async () => {
  const ctx = seamCtx({
    values: (session) => String(session?.seq) === '0'
      ? { costUsage: { input: 10, output: 4, cacheRead: 0, cacheWrite: 0, cost: 0.001 } }
      : { tokenUsage: { uncachedInputTokens: 6, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    liveIds: ['session-a', 'session-b'],
  })
  const summary = await assembleTeamCost(ctx, [member({ id: 'session-a' }), member({ id: 'session-b', name: 'researcher-1' })])
  assert.equal(summary.status, 'ok')
  assert.equal(summary.source, 'projection:costUsage')
  assert.equal(summary.members[0].reading.inputTokens.source, 'projection:costUsage')
  assert.equal(summary.members[1].reading.inputTokens.source, 'projection:tokenUsage')
  assert.deepEqual(summary.totals.inputTokens, { value: 16, source: 'projection:costUsage' })
})

test('投影回落：会话全未附加 → no-data 且无数字', async () => {
  const ctx = seamCtx({ values: () => ({}), liveIds: [] })
  const summary = await assembleTeamCost(ctx, [member()])
  assert.equal(summary.status, 'no-data')
  assert.deepEqual(numbersOf(summary), [])
})

test('投影回落：单会话快照抛错只让该成员缺数据', async () => {
  const ctx = {
    get: (key) => {
      if (key === SESSION_PROJECTIONS_SERVICE_KEY) {
        return { snapshot: (session) => {
          if (String(session?.seq) === '9') throw new Error('fold failed')
          return { asOfSeq: 1, values: { tokenUsage: { uncachedInputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } } }
        } }
      }
      return undefined
    },
    agents: { get: (id) => String(id) === 'session-a' ? { session: { seq: 9 } } : { session: { seq: 7 } } },
  }
  const summary = await assembleTeamCost(ctx, [member({ id: 'session-a' }), member({ id: 'session-b', name: 'researcher-1' })])
  assert.equal(summary.status, 'ok')
  assert.equal(summary.members[0].reading, undefined)
  assert.equal(summary.members[1].reading.inputTokens.source, 'projection:tokenUsage')
})

// ── 快照装配层 ──

test('快照装配层：cost 字段落位且既有字段投影无回归', async () => {
  const ledgerRow = { found: true, own: { input: 100, output: 50, cacheRead: 200, cacheWrite: 10, cost: 0.02, apiCost: 0.02 } }
  const ctx = {
    logger: { warn() {} },
    get: (key) => key === COST_METER_SERVICE_KEY ? costMeterStub((id) => id === 'session-a' ? ledgerRow : { found: false }) : undefined,
    agents: { get: () => undefined },
  }
  const state = {
    id: 'team-a',
    name: 'A',
    captainSessionId: 'session-1',
    createdAt: 1,
    members: [{ id: 'session-a', name: 'engineer-1', joinedAt: 1, status: 'idle' }],
    tasks: [],
    taskSeq: 0,
  }
  const snapshot = await assembleTeamSnapshot(ctx, 'Z:\\nonexistent-state-root', 'dev', state, { historic: true })
  assert.ok(snapshot.cost !== undefined)
  assert.equal(snapshot.cost.status, 'ok')
  assert.equal(snapshot.cost.source, 'cost-meter:service')
  assert.equal(snapshot.cost.totals.inputTokens.value, 100)
  assert.equal(snapshot.cost.members.length, 1)
  // 既有字段无回归
  assert.equal(snapshot.teamId, 'team-a')
  assert.equal(snapshot.captainSessionId, 'session-1')
  assert.deepEqual(snapshot.tasks, [])
  assert.equal(snapshot.members.length, 1)
  assert.equal(snapshot.members[0].name, 'engineer-1')
})

test('快照装配层：无来源时 cost 为明确 no-data（不缺省、不报错、无数字）', async () => {
  const ctx = { logger: { warn() {} }, get: () => undefined }
  const state = {
    id: 'team-b',
    name: 'B',
    captainSessionId: 'session-2',
    createdAt: 1,
    members: [],
    tasks: [],
    taskSeq: 0,
  }
  const snapshot = await assembleTeamSnapshot(ctx, 'Z:\\nonexistent-state-root', 'dev', state, { historic: true })
  assert.equal(snapshot.cost.status, 'no-data')
  assert.ok(typeof snapshot.cost.reason === 'string' && snapshot.cost.reason.length > 0)
  assert.deepEqual(numbersOf(snapshot.cost), [])
})

// ── 快照边界 guard ──

test('guard：合法形状通过，坏形状拒绝', () => {
  const valid = {
    status: 'ok',
    source: 'cost-meter:service',
    totals: { inputTokens: { value: 1, source: 'cost-meter:service' } },
    members: [{ memberId: 's', memberName: 'm', reading: { costEstimate: { value: 0.5, source: 'cost-meter:service' } }, attributedSubsessions: 2 }],
  }
  assert.equal(isTeamCostSummary(valid), true)
  assert.equal(isTeamCostSummary({ status: 'no-data', reason: '来源缺席' }), true)
  assert.equal(isTeamCostSummary(null), false)
  assert.equal(isTeamCostSummary('junk'), false)
  assert.equal(isTeamCostSummary({ status: 'pending' }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', source: 'guess' }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', reason: 42 }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', totals: 'none' }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', totals: { inputTokens: { value: 'x', source: 'cost-meter:service' } } }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', totals: { inputTokens: { value: 1 } } }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', totals: { inputTokens: { value: -1, source: 'cost-meter:service' } } }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', members: 'all' }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', members: [{ memberId: 1, memberName: 'm' }] }), false)
  assert.equal(isTeamCostSummary({ status: 'ok', members: [{ memberId: 's', memberName: 'm', attributedSubsessions: 1.5 }] }), false)
})

// ── payload 尺寸 ──

test('payload 尺寸：8 成员典型形状 ≤ 4KB', async () => {
  const members = Array.from({ length: 8 }, (_, index) => member({ id: `session-${index}`, name: `member-${index}` }))
  const ctx = {
    get: (key) => key === COST_METER_SERVICE_KEY
      ? costMeterStub((id) => ({ found: true, own: { input: 1200, output: 400, cacheRead: 2400, cacheWrite: 100, cost: 0.021, apiCost: 0.021 } }))
      : undefined,
  }
  const summary = await assembleTeamCost(ctx, members)
  const bytes = Buffer.byteLength(JSON.stringify(summary), 'utf8')
  assert.ok(bytes <= 4096, `typical 8-member cost summary should stay within 4KB, got ${bytes} bytes`)
})
