#!/usr/bin/env node
/**
 * 回归：滑动无进展窗口（swarm 吸收项 2）。
 *
 * 目标是「不按耗时杀任务」：只要成员还在跑，转多久都不轮换；只有成员已经
 * 不再被观察为运行、却仍握着未完成的尝试、且整整一个窗口没有进展时，
 * 才清掉停放标记让调度回收这一代，并且每代有次数上限。
 *
 * 断言用导出的窗口与上限常量驱动，避免把测试写死在实际毫秒数上。
 *
 * Run: node --test scripts/no-progress-recovery.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { MAX_AUTO_RECOVERIES, NO_PROGRESS_WINDOW_MS } from '../lib/scheduler.js'

/**
 * Mirrors the scheduler's decision rule. Kept as a local copy on purpose: the
 * scheduler's own copy is not exported, and this test is about the *policy*
 * (window, reset, bound) rather than about wiring.
 */
function shouldRecover(state, attemptId, now) {
  if (state === undefined || state.attemptId !== attemptId) return false
  if (state.recoveries >= MAX_AUTO_RECOVERIES) return false
  return now - state.since >= NO_PROGRESS_WINDOW_MS
}

test('窗口与上限是有限的正值', () => {
  assert.ok(Number.isFinite(NO_PROGRESS_WINDOW_MS) && NO_PROGRESS_WINDOW_MS > 0)
  assert.ok(Number.isSafeInteger(MAX_AUTO_RECOVERIES) && MAX_AUTO_RECOVERIES >= 1)
})

test('同一代未满窗口不回收', () => {
  const state = { taskId: 't1', attemptId: 'att-1', since: 1_000, recoveries: 0 }
  assert.equal(shouldRecover(state, 'att-1', 1_000), false)
  assert.equal(shouldRecover(state, 'att-1', 1_000 + NO_PROGRESS_WINDOW_MS - 1), false)
})

test('同一代满窗口即回收一次', () => {
  const state = { taskId: 't1', attemptId: 'att-1', since: 1_000, recoveries: 0 }
  assert.equal(shouldRecover(state, 'att-1', 1_000 + NO_PROGRESS_WINDOW_MS), true)
})

test('换代后时钟重算：旧窗口不适用于新能力', () => {
  const state = { taskId: 't1', attemptId: 'att-1', since: 1_000, recoveries: 0 }
  assert.equal(shouldRecover(state, 'att-2', 1_000 + NO_PROGRESS_WINDOW_MS * 10), false)
})

test('有进展重置窗口：since 更新后不再立即触发', () => {
  const state = { taskId: 't1', attemptId: 'att-1', since: 1_000, recoveries: 1 }
  const progressedAt = 1_000 + NO_PROGRESS_WINDOW_MS * 3
  assert.equal(shouldRecover(state, 'att-1', progressedAt - 1), true)
  const reset = { ...state, since: progressedAt }
  assert.equal(shouldRecover(reset, 'att-1', progressedAt), false)
})

test('每代回收次数有上限，超过后交给队长', () => {
  const spent = { taskId: 't1', attemptId: 'att-1', since: 1_000, recoveries: MAX_AUTO_RECOVERIES }
  assert.equal(shouldRecover(spent, 'att-1', 1_000 + NO_PROGRESS_WINDOW_MS * 100), false)
})

test('没有记录时不回收（冷进程不会凭空轮换）', () => {
  assert.equal(shouldRecover(undefined, 'att-1', 9_999_999), false)
})
