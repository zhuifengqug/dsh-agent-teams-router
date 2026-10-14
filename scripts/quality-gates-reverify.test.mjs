#!/usr/bin/env node
/**
 * 回归：验证只按「每个命令最新一次观察」判定，且完成证据必须属于当前 attempt。
 *
 * 两条规则来自本次改造（swarm 吸收项 1 与 3）：
 * - 修复产物后**重跑失败命令**即可，不必重做实现。旧实现用
 *   `commands.some(status==='failed')` 做「见过失败就永远失败」，一旦某个命令失败过，
 *   同一 attempt 内的成功重跑也无法让任务完成，逼出整轮实现重做。
 * - 证据带产出代戳 `evidenceAttemptId`。换代（重派/重试/冷恢复）后，
 *   上一代记录的 pass 不能把当前能力带到 completed。
 *
 * Run: node --test scripts/quality-gates-reverify.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { evaluateQualityCompletion } from '../lib/quality-gates.js'

const VERIFY = ['node --test scripts/a.test.mjs', 'pnpm typecheck']

function implTask(extra = {}) {
  return {
    id: 't1', subject: 'impl', status: 'in_progress', dependencies: [],
    createdAt: 0, updatedAt: 0, attempt: 1, kind: 'implementation',
    assignee: 'implementer',
    objective: 'Ship the change',
    inScope: ['src/'],
    acceptance: ['the change is in place'],
    verify: [...VERIFY],
    ...extra,
  }
}

function passing(task, attemptId) {
  return {
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: task.acceptance.map((criterion) => ({ criterion, status: 'passed' })),
    commandsRun: task.verify.map((command) => ({ command, status: 'passed' })),
    ...attemptId === undefined ? {} : { evidenceAttemptId: attemptId },
  }
}

test('重跑失败命令可以清掉早期失败：只有最新一次观察作数', () => {
  const task = implTask({ attemptId: 'att-1', evidenceAttemptId: 'att-1' })
  // 第一次 verify 失败，产物修好后同一 attempt 内重跑成功 —— 序列里两条都在。
  const rerun = {
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: task.acceptance.map((criterion) => ({ criterion, status: 'passed' })),
    commandsRun: [
      { command: VERIFY[0], status: 'failed', exitCode: 1, evidence: 'first run' },
      { command: VERIFY[1], status: 'passed', exitCode: 0 },
      { command: VERIFY[0], status: 'passed', exitCode: 0, evidence: 'after the fix' },
    ],
  }
  const gate = evaluateQualityCompletion(task, rerun)
  assert.equal(gate.ok, true, `重跑成功应当可以完成，实际：${gate.error}`)
})

test('最新一次仍是失败就不许完成', () => {
  const task = implTask({ attemptId: 'att-1', evidenceAttemptId: 'att-1' })
  const stillFailing = {
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: task.acceptance.map((criterion) => ({ criterion, status: 'passed' })),
    commandsRun: [
      { command: VERIFY[0], status: 'passed', exitCode: 0 },
      { command: VERIFY[0], status: 'failed', exitCode: 1 },
      { command: VERIFY[1], status: 'passed', exitCode: 0 },
    ],
  }
  const gate = evaluateQualityCompletion(task, stillFailing)
  assert.equal(gate.ok, false)
  assert.match(gate.error, /verify failure must fail the task/)
})

test('丢掉失败条目不能骗过覆盖检查：命令仍须逐条有结果', () => {
  const task = implTask({ attemptId: 'att-1', evidenceAttemptId: 'att-1' })
  const dropped = {
    status: 'completed',
    changedPaths: ['src/a.ts'],
    acceptanceResults: task.acceptance.map((criterion) => ({ criterion, status: 'passed' })),
    commandsRun: [{ command: VERIFY[0], status: 'passed', exitCode: 0 }],
  }
  const gate = evaluateQualityCompletion(task, dropped)
  assert.equal(gate.ok, false)
})

test('上一代（不同 attemptId）记录的通过不能带当前能力完成', () => {
  const task = implTask({ attemptId: 'att-2', evidenceAttemptId: 'att-1' })
  // 本次更新不自带证据，闸门只能依赖任务上存的旧证据。
  const gate = evaluateQualityCompletion(task, { status: 'completed' })
  assert.equal(gate.ok, false)
  assert.match(gate.error, /previous attempt/)
})

test('本代自带证据时不受旧戳影响', () => {
  const task = implTask({ attemptId: 'att-2', evidenceAttemptId: 'att-1' })
  const gate = evaluateQualityCompletion(task, passing(task, 'att-2'))
  assert.equal(gate.ok, true, `本代重交证据应当可以完成，实际：${gate.error}`)
})

test('无戳的历史任务保持可读可完成（兼容旧 team.json）', () => {
  // 升级前写下的证据没有代戳：只凭「没有戳」不能判定它不属于本代，
  // 否则所有在途任务都会无故卡死。有戳且对不上才拒绝。
  const task = implTask({
    attemptId: 'att-1',
    changedPaths: ['src/a.ts'],
    acceptanceResults: [{ criterion: 'the change is in place', status: 'passed' }],
    commandsRun: VERIFY.map((command) => ({ command, status: 'passed', exitCode: 0 })),
  })
  const gate = evaluateQualityCompletion(task, { status: 'completed' })
  assert.equal(gate.ok, true, `旧任务不应因缺少戳而卡死，实际：${gate.error}`)
})

test('review 类：上一代记录的 verdict 不能带当前能力完成', () => {
  const review = {
    id: 't2', subject: 'review', status: 'in_progress', dependencies: ['t1'],
    createdAt: 0, updatedAt: 0, attempt: 1, kind: 'review',
    assignee: 'reviewer', reviewedTaskId: 't1',
    verdict: 'pass', findings: [],
    attemptId: 'att-2', evidenceAttemptId: 'att-1',
  }
  const gate = evaluateQualityCompletion(review, { status: 'completed' })
  assert.equal(gate.ok, false)
  assert.match(gate.error, /previous attempt/)

  const resubmitted = evaluateQualityCompletion(review, { status: 'completed', verdict: 'pass', findings: [] })
  assert.equal(resubmitted.ok, true, `本代重交 verdict 应当可以完成，实际：${resubmitted.error}`)
})
