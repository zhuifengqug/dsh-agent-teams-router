import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { createTeamDir, readTeam, writeTeam, beginTaskAttempt, isTeamTask } from '../lib/state.js'
import { collectTeamsActivity } from '../lib/snapshot.js'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'quality-surfaces-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  await mkdir(join(workspace, 'src'))
  await writeFile(join(workspace, 'src/app.js'), 'export const value = 1\n')
  const session = { header: { cwd: workspace, seedLength: 0 }, events: [], append() {}, requestHeader: () => ({ config: { provider: 'fake', model: 'model' } }) }
  const captain = { id: 'captain', status: 'running', options: {}, session, steer() {}, followup() {}, cancel() {}, whenIdle: async () => {} }
  const member = { ...captain, id: 'reviewer-id' }
  const definitions = new Map()
  const ctx = {
    effect: fn => fn(), on: () => () => {}, get: () => undefined,
    logger: { warn() {}, debug() {} },
    tools: { register: definition => definitions.set(definition.name, definition) },
    agents: { get: id => id === captain.id ? captain : id === member.id ? member : undefined },
    llm: { resolveCallConfig: async config => config, listModels: async () => [] },
    subagents: { followup: async () => 'message', sendMessage: async () => 'message', registerContinuableSetup: () => () => {}, listChildren: async () => [], listDescendants: async () => [], interrupt() {} },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {} })
  const stamp = Date.now()
  const base = { dependencies: [], attempt: 1, createdAt: stamp, updatedAt: stamp }
  const state = {
    id: 'audit', name: 'audit', captainSessionId: captain.id, createdAt: stamp, taskSeq: 2,
    members: [{ id: member.id, name: 'reviewer', role: 'reviewer', status: 'working', joinedAt: stamp }, { id: 'engineer-id', name: 'engineer', status: 'idle', joinedAt: stamp }],
    tasks: [
      { ...base, id: 't1', subject: 'implementation', kind: 'implementation', status: 'completed', inScope: ['src/'], changedPaths: ['src/app.js'], verify: ['node --test'], acceptance: ['done'] },
      { ...base, attempt: 0, id: 't2', subject: 'review', kind: 'review', status: 'pending', assignee: 'reviewer', dependencies: ['t1'], reviewedTaskId: 't1', objective: 'review', acceptance: ['done'] },
    ],
  }
  const root = join(workspace, '.agent-teams')
  await createTeamDir(root, state)
  const call = (name, args, agent = member) => definitions.get(name).execute(args, { agent, signal: new AbortController().signal })
  return { workspace, root, ctx, captain, member, call, definitions }
}

test('claim/close persist byte identity; status and panel both reject later edits', async t => {
  const f = await fixture(t)
  const claim = await f.call('agent_teams_claim_task', { task_id: 't2' })
  let team = await readTeam(f.root, 'audit')
  assert.equal(team.tasks[1].verdictStartSnapshot.artifacts[0].sha256.length, 64)
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'in_progress' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'completed', verdict: 'pass' })
  team = await readTeam(f.root, 'audit')
  assert.equal(team.tasks[1].reviewedArtifacts[0].sha256.length, 64)
  assert.equal(team.tasks[1].reviewedAttempt, 1)
  assert.equal((await f.call('agent_teams_status', {}, f.captain)).delivery.ok, true)
  await writeFile(join(f.workspace, 'src/app.js'), 'export const value = 2\n')
  const status = await f.call('agent_teams_status', {}, f.captain)
  const [panel] = await collectTeamsActivity(f.ctx, [{ workspace: 'fixture', stateRoot: f.root, workspacePath: f.workspace }])
  assert.equal(status.delivery.ok, false)
  assert.deepEqual(panel.delivery, status.delivery)
  assert.ok(status.tasks[1].verdict_stale)
  assert.ok(panel.tasks[1].verdictStale)
  assert.match(f.definitions.get('agent_teams_status').output.render({}, status)[0].text, /verdict.*revision|sha256/)
})

test('changes between real claim and close retain reviewedDuringDrift', async t => {
  const f = await fixture(t)
  const claim = await f.call('agent_teams_claim_task', { task_id: 't2' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'in_progress' })
  await writeFile(join(f.workspace, 'src/app.js'), 'changed while reviewing\n')
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'completed', verdict: 'pass' })
  const team = await readTeam(f.root, 'audit')
  assert.ok(team.tasks[1].reviewedDuringDrift.length)
  const status = await f.call('agent_teams_status', {}, f.captain)
  assert.equal(status.delivery.ok, false)
  assert.match(status.delivery.blockers.join(' '), /being formed|stable revision/)
})

test('an empty reviewed directory remains bound and later additions block delivery', async t => {
  const f = await fixture(t)
  let team = await readTeam(f.root, 'audit')
  await mkdir(join(f.workspace, 'empty'))
  team.tasks[0].inScope = ['empty/']
  team.tasks[0].changedPaths = []
  await writeTeam(f.root, team)
  const claim = await f.call('agent_teams_claim_task', { task_id: 't2' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'in_progress' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'completed', verdict: 'pass' })
  team = await readTeam(f.root, 'audit')
  assert.deepEqual(team.tasks[1].reviewedScope, ['empty/'])
  assert.deepEqual(team.tasks[1].reviewedArtifacts, [])
  await writeFile(join(f.workspace, 'empty/new.js'), 'new code')
  const status = await f.call('agent_teams_status', {}, f.captain)
  assert.equal(status.delivery.ok, false)
  assert.match(status.delivery.blockers.join(' '), /never reviewed/)
})

test('reviewed task generation changing during review invalidates even identical bytes', async t => {
  const f = await fixture(t)
  const claim = await f.call('agent_teams_claim_task', { task_id: 't2' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'in_progress' })
  const team = await readTeam(f.root, 'audit')
  team.tasks[0].attempt += 1
  await writeTeam(f.root, team)
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'completed', verdict: 'pass' })
  const status = await f.call('agent_teams_status', {}, f.captain)
  assert.equal(status.delivery.ok, false)
  assert.match(status.delivery.blockers.join(' '), /re-attempted during/)
})

test('tool failure creates a causal repair snapshot and rewires pending integration', async t => {
  const f = await fixture(t)
  let team = await readTeam(f.root, 'audit')
  team.tasks[1].kind = 'verification'
  delete team.tasks[1].reviewedTaskId
  team.tasks[1].verify = ['node --test']
  team.tasks.push({ id: 't3', subject: 'integration', kind: 'integration', status: 'pending', dependencies: ['t2'], createdAt: Date.now(), updatedAt: Date.now(), objective: 'ship', acceptance: ['done'] })
  team.taskSeq = 3
  await writeTeam(f.root, team)
  const claim = await f.call('agent_teams_claim_task', { task_id: 't2' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'in_progress' })
  await f.call('agent_teams_update_task', { task_id: 't2', attempt_id: claim.attempt_id, status: 'failed', commandsRun: [{ command: 'node --test', status: 'failed', exitCode: 1 }] })
  team = await readTeam(f.root, 'audit')
  const repair = team.tasks.find(task => task.kind === 'repair')
  const recheck = team.tasks.find(task => task.kind === 'verification' && task.id !== 't2')
  assert.deepEqual(repair.findingSourceTaskIds, ['t2'])
  assert.deepEqual(repair.dependencies, ['t1'])
  assert.equal(repair.contractSnapshot.artifacts[0].sha256.length, 64)
  assert.deepEqual(team.tasks[2].dependencies, [recheck.id])
  assert.equal(isTeamTask(repair), true)
  const broken = { ...repair, contractSnapshot: { at: 0, artifacts: [{ path: 'src/app.js', present: true, sha256: 'invalid' }] } }
  assert.equal(isTeamTask(broken), false)
  beginTaskAttempt(team.tasks[1], 'reviewer')
  assert.equal(team.tasks[1].reviewedArtifacts, undefined)
})

const { canDeclareDelivery, planQualityFollowUp, validateCreateTask } = await import('../lib/quality-gates.js')
const { auditTeamWorkspace } = await import('../lib/workspace-audit.js')
const { snapshotWorkspacePaths } = await import('../lib/artifacts.js')
function ruleTeam(tasks) {
  return { id: 'rules', name: 'rules', captainSessionId: 'captain', createdAt: 0, taskSeq: tasks.length,
    members: [{ name: 'engineer', status: 'idle' }, { name: 'reviewer', status: 'idle' }], tasks }
}
function impl(id, paths, dependencies = []) {
  return { id, subject: id, kind: 'implementation', status: 'completed', attempt: 1,
    dependencies, createdAt: 0, updatedAt: 0, assignee: 'engineer', inScope: paths, changedPaths: paths, verify: ['node build.mjs'], acceptance: ['done'] }
}
function pass(id, target, artifacts, createdAt) {
  return { id, subject: id, kind: 'review', status: 'completed', verdict: 'pass', attempt: 1,
    dependencies: [target], reviewedTaskId: target, reviewedAttempt: 1, reviewedArtifacts: artifacts, createdAt, updatedAt: createdAt }
}
const digest = (path, value) => ({ path, present: true, sha256: value.repeat(64), size: 1 })

test('shared requirements do not make unrelated implementations supersede each other', () => {
  const a = impl('a', ['src/a.js'], ['req'])
  const b = impl('b', ['src/b.js'], ['req'])
  const old = pass('ra', 'a', [digest('src/a.js', 'a')], 1)
  const newer = pass('rb', 'b', [digest('src/b.js', 'b')], 2)
  const team = ruleTeam([{ id: 'req', subject: 'req', kind: 'requirements', status: 'completed', verdict: 'pass', dependencies: [], createdAt: 0, updatedAt: 0 }, a, b, old, newer])
  const result = canDeclareDelivery(team, { artifacts: [digest('src/a.js', 'c'), digest('src/b.js', 'b')] })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some(text => text.includes('ra')))
})

test('an unbound later pass and a partial repair cannot erase unmatched old byte evidence', () => {
  const original = impl('i', ['src/a.js', 'src/b.js'])
  const old = pass('old', 'i', [digest('src/a.js', 'a')], 1)
  const legacy = { ...pass('legacy', 'i', undefined, 2), reviewedArtifacts: undefined }
  let result = canDeclareDelivery(ruleTeam([original, old, legacy]), { artifacts: [digest('src/a.js', 'c')] })
  assert.equal(result.ok, false)
  const repair = { ...impl('repair', ['src/b.js']), kind: 'repair', sourceTaskId: 'i' }
  const partial = pass('partial', 'repair', [digest('src/b.js', 'b')], 3)
  result = canDeclareDelivery(ruleTeam([original, old, repair, partial]), { artifacts: [digest('src/a.js', 'c'), digest('src/b.js', 'b')] })
  assert.equal(result.ok, false)
  assert.ok(result.blockers.some(text => text.includes('old')))
})

test('verification recheck retains its own commands and generated repair satisfies the canonical contract', () => {
  const original = impl('i', ['src/'])
  const gate = { id: 'v', subject: 'integration validation', kind: 'verification', status: 'failed', dependencies: ['i'],
    assignee: 'reviewer', createdAt: 1, updatedAt: 1, verify: ['node integration.mjs'], acceptance: ['integration works'],
    commandsRun: [{ command: 'node integration.mjs', status: 'failed', exitCode: 1 }] }
  const team = ruleTeam([original, gate])
  const planned = planQualityFollowUp(team, gate)
  const repair = planned.created.find(task => task.kind === 'repair')
  const recheck = planned.created.find(task => task.kind === 'verification')
  assert.deepEqual(repair.verify, ['node build.mjs', 'node integration.mjs'])
  assert.deepEqual(recheck.verify, ['node integration.mjs'])
  assert.equal(validateCreateTask(team, repair).ok, true)
  team.members = [team.members[0]]
  assert.equal(planQualityFollowUp(team, gate).escalated, true)
})

test('one finding requiring both an allowed target and an excluded target is escalated whole', () => {
  const original = impl('i', ['src/'])
  const gate = { id: 'r', subject: 'review', kind: 'review', status: 'failed', verdict: 'needs_revision', dependencies: ['i'],
    reviewedTaskId: 'i', assignee: 'reviewer', findings: [{ id: 'mixed', file: 'src/app.js', severity: 'high', problem: 'mismatch', requiredFix: 'Modify src/app.js and secrets/keys.json' }] }
  const planned = planQualityFollowUp(ruleTeam([original, gate]), gate)
  assert.equal(planned.created.length, 0)
  assert.equal(planned.escalated, true)
  assert.deepEqual(planned.excludedFindings, ['mixed'])
})

test('separate reviewed scopes below the cap remain auditable above 200 total files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'quality-independent-caps-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const tasks = []
  for (const name of ['a', 'b']) {
    await mkdir(join(root, name))
    await Promise.all(Array.from({ length: 110 }, (_, index) => writeFile(join(root, name, index + '.js'), String(index))))
    const snapshot = snapshotWorkspacePaths(root, [name + '/'])
    tasks.push(impl(name, [name + '/']), { ...pass('r' + name, name, snapshot.artifacts, 1), reviewedScope: [name + '/'] })
  }
  const team = ruleTeam(tasks)
  const audit = auditTeamWorkspace(root, team)
  assert.deepEqual(audit.gaps ?? [], [])
  assert.equal(canDeclareDelivery(team, audit).ok, true)
})

test('repair of another review on the same implementation does not close a fresh failed gate', () => {
  const original = impl('i', ['src/app.js'])
  const gate = { id: 'r', subject: 'review', kind: 'review', status: 'failed', verdict: 'needs_revision', dependencies: ['i'], reviewedTaskId: 'i',
    findings: [{ id: 'new-finding', severity: 'high', problem: 'bug', requiredFix: 'fix it' }] }
  const unrelated = { ...impl('repair', ['src/app.js']), kind: 'repair', sourceTaskId: 'i', sourceFindingIds: ['old-finding'], findingSourceTaskIds: ['old-review'] }
  const result = canDeclareDelivery(ruleTeam([original, gate, unrelated]))
  assert.ok(result.blockers.includes('r failed without a follow-up repair'))
})
test('content-bound delivery requires a current workspace audit', () => {
  const original = impl('i', ['src/app.js'])
  const review = pass('r', 'i', [digest('src/app.js', 'a')], 1)
  assert.equal(canDeclareDelivery(ruleTeam([original, review])).ok, false)
})

test('different failed verification gates with no findings do not deduplicate each other', () => {
  const original = impl('i', ['src/'])
  const gate = { id: 'v1', subject: 'first', kind: 'verification', status: 'failed', dependencies: ['i'], assignee: 'reviewer', verify: ['node one.mjs'], commandsRun: [{ command: 'node one.mjs', status: 'failed' }] }
  const team = ruleTeam([original, gate])
  const first = planQualityFollowUp(team, gate)
  team.tasks.push({ ...first.created[0], id: 'repair-one', status: 'pending', createdAt: Date.now(), updatedAt: Date.now() })
  const second = { ...gate, id: 'v2', verify: ['node two.mjs'], commandsRun: [{ command: 'node two.mjs', status: 'failed' }] }
  team.tasks.push(second)
  const planned = planQualityFollowUp(team, second)
  assert.equal(planned.created.length, 2)
  assert.deepEqual(planned.created[0].findingSourceTaskIds, ['v2'])
  assert.equal(validateCreateTask(team, planned.created[0]).error?.includes('already covers'), false)
})
test('reused finding ids in another artifact lineage never close this gate', () => {
  const a = impl('a', ['src/a.js']), b = impl('b', ['src/b.js'])
  const gate = { id: 'ra', subject: 'review', kind: 'review', status: 'failed', verdict: 'needs_revision', reviewedTaskId: 'a', dependencies: ['a'], findings: [{ id: 'F1', severity: 'high', problem: 'bug', requiredFix: 'fix it' }] }
  for (const causal of [['rb'], undefined]) {
    const repair = { ...impl('repair-b', ['src/b.js']), kind: 'repair', sourceTaskId: 'b', sourceFindingIds: ['F1'], findingSourceTaskIds: causal }
    assert.ok(canDeclareDelivery(ruleTeam([a,b,gate,repair])).blockers.includes('ra failed without a follow-up repair'))
  }
})
