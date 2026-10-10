import assert from 'node:assert/strict'
import test from 'node:test'

const {
  POPOVER_OPEN_DELAY_MS,
  POPOVER_CLOSE_DELAY_MS,
  routeLine,
  memberRouteKeyParts,
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

test('memberRouteKeyParts splits the frozen routeKey into the D.4 five segments', () => {
  const parts = memberRouteKeyParts({
    difficulty: 'high',
    normalizedRole: 'reviewer',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    reasoningEffort: 'high',
  })
  assert.deepEqual(parts, {
    difficulty: 'high',
    role: 'reviewer',
    provider: 'deepseek',
    model: 'deepseek-reasoner',
    effort: 'high',
  })
})

test('memberRouteKeyParts falls back to the raw role and tolerates missing fields', () => {
  assert.equal(memberRouteKeyParts({ role: '  Reviewer ' }).role, 'Reviewer')
  assert.deepEqual(memberRouteKeyParts({}), {
    difficulty: '', role: '', provider: '', model: '', effort: '',
  })
})
