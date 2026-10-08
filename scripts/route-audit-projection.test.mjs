/**
 * 步 5（B 段数据层）：routeAudit 投影进团队快照的行为测试。
 *
 * 覆盖：
 * - audit 超过 12 条 → 只保留最近 12 条 + total/truncated 计数；
 * - 字段缺失 / 畸形数据不炸投影（缺省为空值，绝不抛错）；
 * - degraded / fallback 标志透传（tier-degrade、fallback 步骤 + fallback 来源）；
 * - reasoningEffort 取自 resolvedRoute.reasoning_effort（空值省略）；
 * - state.ts durable guard 同步：audit 条目的 route 子对象形状校验；
 * - 快照装配层字段落位与既有字段投影无回归；
 * - 典型 audit 的快照增量 ≤ 1KB。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ROUTE_AUDIT_SNAPSHOT_LIMIT,
  isTeamTask,
  projectRouteAudit,
  projectTaskRouteActivity,
} from '../lib/state.js'
import { assembleTeamSnapshot } from '../lib/snapshot.js'

/** Build one durable audit entry shaped like the Value Router's RouteAuditEntry. */
function entry(overrides = {}) {
  return {
    at: 1_728_000_000_000,
    step: 'tier-rotate',
    outcome: 'ok',
    detail: 'high 档 3 条线路，取序号 0',
    ...overrides,
  }
}

test('ROUTE_AUDIT_SNAPSHOT_LIMIT 为 12', () => {
  assert.equal(ROUTE_AUDIT_SNAPSHOT_LIMIT, 12)
})

test('audit 超过 12 条：保留最近 12 条（时间序不变）并给出被截总数', () => {
  const audit = Array.from({ length: 20 }, (_, index) => entry({ step: `step-${index}` }))
  const projection = projectRouteAudit(audit)
  assert.ok(projection !== undefined)
  assert.equal(projection.total, 20)
  assert.equal(projection.truncated, 8)
  assert.equal(projection.entries.length, 12)
  assert.equal(projection.entries[0].step, 'step-8')
  assert.equal(projection.entries.at(-1).step, 'step-19')
})

test('audit 不超过 12 条：truncated 为 0，投影逐条对应', () => {
  const audit = [entry({ step: 'validate' }), entry({ step: 'tier-rotate' })]
  const projection = projectRouteAudit(audit)
  assert.equal(projection.total, 2)
  assert.equal(projection.truncated, 0)
  assert.deepEqual(projection.entries.map(step => step.step), ['validate', 'tier-rotate'])
})

test('字段缺失不炸：非数组返回 undefined，畸形条目降级为空值', () => {
  assert.equal(projectRouteAudit(undefined), undefined)
  assert.equal(projectRouteAudit('junk'), undefined)
  assert.equal(projectRouteAudit({ length: 2 }), undefined)
  const projection = projectRouteAudit([null, 'x', { step: 'validate' }, entry()])
  assert.equal(projection.total, 4)
  assert.equal(projection.entries.length, 2)
  const bare = projection.entries[0]
  assert.equal(bare.step, 'validate')
  assert.equal(bare.outcome, '')
  assert.equal(bare.detail, '')
  assert.equal(bare.at, 0)
  assert.equal(bare.tier, undefined)
  assert.equal(bare.route, undefined)
})

test('字段缺失不炸：projectTaskRouteActivity 对空对象返回空投影', () => {
  assert.deepEqual(projectTaskRouteActivity({}), {})
})

test('detail 超长截断到每条上限', () => {
  const projection = projectRouteAudit([entry({ detail: 'x'.repeat(500) })])
  assert.equal(projection.entries[0].detail.length, 200)
})

test('degraded 标志：tier-degrade 且 outcome=ok 才透传，skipped 不算降级', () => {
  const degraded = projectTaskRouteActivity({ routeAudit: [entry({ step: 'tier-degrade', outcome: 'ok', detail: 'high 档无可用线路，降到 medium 档' })] })
  assert.equal(degraded.degraded, true)
  assert.equal(degraded.fallback, undefined)

  const skipped = projectTaskRouteActivity({ routeAudit: [entry({ step: 'tier-degrade', outcome: 'skipped' })] })
  assert.equal(skipped.degraded, undefined)
})

test('fallback 标志：fallback 步骤 outcome=ok 透传，skipped 不算兜底', () => {
  const fallback = projectTaskRouteActivity({ routeAudit: [entry({ step: 'fallback', outcome: 'ok', detail: '四档均无可用线路，使用全局兜底' })] })
  assert.equal(fallback.fallback, true)
  assert.equal(fallback.degraded, undefined)

  const skipped = projectTaskRouteActivity({ routeAudit: [entry({ step: 'fallback', outcome: 'skipped', detail: '未配置全局兜底线路' })] })
  assert.equal(skipped.fallback, undefined)
})

test('fallback 标志：routeResolvedSource=fallback 无 fallback 步骤也透传', () => {
  const projected = projectTaskRouteActivity({ routeResolvedSource: 'fallback' })
  assert.equal(projected.fallback, true)
})

test('降级与兜底可同时成立', () => {
  const projected = projectTaskRouteActivity({
    routeAudit: [
      entry({ step: 'tier-degrade', outcome: 'ok' }),
      entry({ step: 'fallback', outcome: 'ok' }),
    ],
  })
  assert.equal(projected.degraded, true)
  assert.equal(projected.fallback, true)
})

test('普通解析不产生 degraded/fallback 标志', () => {
  const projected = projectTaskRouteActivity({
    routeAudit: [entry({ step: 'validate' }), entry({ step: 'tier-rotate' })],
    routeResolvedSource: 'difficulty',
  })
  assert.equal(projected.degraded, undefined)
  assert.equal(projected.fallback, undefined)
})

test('reasoningEffort 取自 resolvedRoute.reasoning_effort，空值省略', () => {
  const withEffort = projectTaskRouteActivity({ resolvedRoute: { provider: 'deepseek', model: 'reasoner', reasoning_effort: 'high' } })
  assert.equal(withEffort.reasoningEffort, 'high')
  const blank = projectTaskRouteActivity({ resolvedRoute: { provider: 'deepseek', model: 'chat', reasoning_effort: '' } })
  assert.equal(blank.reasoningEffort, undefined)
  assert.equal(projectTaskRouteActivity({}).reasoningEffort, undefined)
})

test('state guard 同步：audit 条目带合法 route 子对象通过，畸形 route 拒绝', () => {
  const base = { id: 't1', subject: 'x', status: 'pending', dependencies: [], createdAt: 1, updatedAt: 1 }
  const valid = {
    ...base,
    routeAudit: [
      entry({ route: { provider: 'deepseek', model: 'reasoner', reasoning_effort: 'high', status: 'resolved' } }),
      entry({ route: { provider: 'deepseek', model: 'chat', reasoning_effort: '' } }),
    ],
  }
  assert.equal(isTeamTask(valid), true)
  assert.equal(isTeamTask({ ...base, routeAudit: [entry({ route: 'nope' })] }), false)
  assert.equal(isTeamTask({ ...base, routeAudit: [entry({ route: { provider: 42 } })] }), false)
})

test('快照装配层：新字段落位且既有字段投影无回归', async () => {
  const task = {
    id: 't1',
    subject: '实现某功能',
    status: 'in_progress',
    assignee: 'engineer-1',
    dependencies: [],
    difficulty: 'high',
    routeStatus: 'resolved',
    routeResolvedSource: 'difficulty',
    resolvedRoute: { provider: 'deepseek', model: 'reasoner', reasoning_effort: 'high' },
    routeAudit: [
      entry({ step: 'validate' }),
      entry({ step: 'tier-rotate', route: { provider: 'deepseek', model: 'reasoner', reasoning_effort: 'high', status: 'resolved' } }),
    ],
    createdAt: 1,
    updatedAt: 2,
  }
  const state = {
    id: 'team-a',
    name: 'A',
    captainSessionId: 'session-1',
    createdAt: 1,
    members: [],
    tasks: [task],
    taskSeq: 1,
  }
  const ctx = { logger: { warn() {} } }
  const snapshot = await assembleTeamSnapshot(ctx, 'Z:\\nonexistent-state-root', 'dev', state, { historic: true })
  assert.equal(snapshot.tasks.length, 1)
  const row = snapshot.tasks[0]
  // 新字段
  assert.ok(row.routeAudit !== undefined)
  assert.equal(row.routeAudit.total, 2)
  assert.equal(row.routeAudit.truncated, 0)
  assert.equal(row.routeAudit.entries.length, 2)
  assert.equal(row.routeAudit.entries[1].route.model, 'reasoner')
  assert.equal(row.degraded, undefined)
  assert.equal(row.fallback, undefined)
  assert.equal(row.reasoningEffort, 'high')
  // 既有字段投影无回归
  assert.equal(row.difficulty, 'high')
  assert.equal(row.routeStatus, 'resolved')
  assert.equal(row.routeSource, 'difficulty')
  assert.equal(row.id, 't1')
  assert.equal(row.state, 'running')
  assert.equal(row.model, '')
})

test('快照装配层：降级与兜底透传到任务行', async () => {
  const task = {
    id: 't2',
    subject: '疑难根因',
    status: 'pending',
    dependencies: [],
    routeResolvedSource: 'fallback',
    resolvedRoute: { provider: 'deepseek', model: 'chat', reasoning_effort: '' },
    routeAudit: [
      entry({ step: 'validate' }),
      entry({ step: 'tier-degrade', outcome: 'ok', detail: 'high 档无可用线路，降到 medium 档' }),
      entry({ step: 'fallback', outcome: 'ok', detail: '四档均无可用线路，使用全局兜底' }),
    ],
    createdAt: 1,
    updatedAt: 2,
  }
  const state = {
    id: 'team-b',
    name: 'B',
    captainSessionId: 'session-2',
    createdAt: 1,
    members: [],
    tasks: [task],
    taskSeq: 1,
  }
  const snapshot = await assembleTeamSnapshot({ logger: { warn() {} } }, 'Z:\\nonexistent-state-root', 'dev', state, { historic: true })
  const row = snapshot.tasks[0]
  assert.equal(row.degraded, true)
  assert.equal(row.fallback, true)
  assert.equal(row.reasoningEffort, undefined)
})

test('快照 payload：典型 audit（2-3 条步骤）每任务增量约 ≤1KB', () => {
  const audit = [
    entry({ step: 'validate', detail: 'difficulty=high role=backend' }),
    entry({ step: 'tier-rotate', detail: 'high 档 3 条线路，取序号 0', route: { provider: 'deepseek', model: 'reasoner', reasoning_effort: 'high', status: 'resolved' } }),
  ]
  const projected = projectTaskRouteActivity({ routeAudit: audit, resolvedRoute: { provider: 'deepseek', model: 'reasoner', reasoning_effort: 'high' } })
  const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8')
  assert.ok(bytes <= 1024, `typical audit projection should stay within ~1KB, got ${bytes} bytes`)
})
