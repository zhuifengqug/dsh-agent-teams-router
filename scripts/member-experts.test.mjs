import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { readTeam } from '../lib/state.js'
import { collectTeamsActivity } from '../lib/snapshot.js'

async function fixture(t) {
  const workspace = await mkdtemp(join(tmpdir(), 'member-experts-'))
  t.after(() => rm(workspace, { recursive: true, force: true }))
  const calls = []
  const services = {
    agencyAgentsLibrary: { catalog: async () => ({ experts: [{ slug: 'engineer', division: 'engineering', description: 'Builds code' }, { slug: 'designer', division: 'design', description: 'Designs UI' }], enabled: ['engineer'] }) },
    agencyAgentsPersona: { getPrompt: async slug => { calls.push(slug); return { prompt: 'Persona: ' + slug } } },
  }
  const definitions = new Map()
  const captain = { id: 'captain', status: 'running', options: { provider: 'fake', model: 'model' }, session: { header: { cwd: workspace }, events: [], append() {}, requestHeader: () => ({ config: { provider: 'fake', model: 'model' } }) }, cancel() {}, whenIdle: async () => {} }
  const ctx = {
    get: key => services[key], effect: fn => fn(), on: () => () => {},
    agents: { get: id => id === captain.id ? captain : undefined }, logger: { warn() {}, debug() {} },
    tools: { register: definition => definitions.set(definition.name, definition) },
    llm: { resolveCallConfig: async config => config, listModels: async () => [] },
    subagents: { followup: async () => 'message', sendMessage: async () => 'message', registerContinuableSetup: () => () => {}, listChildren: async () => [], listDescendants: async () => [] },
  }
  registerAgentTeamsTools(ctx, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {} })
  const call = (name, args, agent = captain) => definitions.get(name).execute(args, { agent, signal: new AbortController().signal })
  return { workspace, ctx, captain, services, calls, definitions, call, root: join(workspace, '.agent-teams') }
}

test('complete expert directory is metadata-only; creation freezes one enabled selection and reuse does not reload it', async t => {
  const f = await fixture(t)
  const catalog = await f.call('agent_teams_experts', {})
  assert.deepEqual(catalog.experts.map(item => [item.slug, item.enabled]), [['engineer', true], ['designer', false]])
  assert.deepEqual(f.calls, [])
  await f.call('agent_teams_create', { name: 'Expert test', approval: 'required' })
  const created = await f.call('agent_teams_add_member', { name: 'builder', role: 'engineer', expert: 'engineer', executionPrompt: 'Task guidance' })
  assert.equal(created.expert, 'engineer')
  assert.deepEqual(f.calls, ['engineer'])
  delete f.services.agencyAgentsPersona
  const reused = await f.call('agent_teams_add_member', { name: 'builder', expert: 'designer' })
  assert.equal(reused.reused, true)
  assert.equal(reused.expert, 'engineer')
  assert.deepEqual(f.calls, ['engineer'])
  const team = await readTeam(f.root, 'expert-test')
  assert.match(team.members[0].executionPrompt, /Persona: engineer\n\nTask guidance/)
  const status = await f.call('agent_teams_status', {})
  const text = f.definitions.get('agent_teams_status').output.render({}, status)[0].text
  assert.match(text, /expert engineer/)
  const [panel] = await collectTeamsActivity(f.ctx, [{ workspace: 'test', stateRoot: f.root, workspacePath: f.workspace }])
  assert.equal(panel.members[0].expert, 'engineer')
})

test('disabled, missing and unavailable expert selections silently create ordinary members', async t => {
  const f = await fixture(t)
  await f.call('agent_teams_create', { name: 'Ordinary', approval: 'required' })
  for (const [name, expert] of [['disabled', 'designer'], ['unknown', 'unknown'], ['plain', undefined]]) {
    const created = await f.call('agent_teams_add_member', { name, ...(expert === undefined ? {} : { expert }), executionPrompt: 'Keep guidance' })
    assert.equal(created.expert, undefined)
  }
  delete f.services.agencyAgentsPersona
  const created = await f.call('agent_teams_add_member', { name: 'unavailable', expert: 'engineer' })
  assert.equal(created.expert, undefined)
  assert.deepEqual(f.calls, [])
  const team = await readTeam(f.root, 'ordinary')
  assert.ok(team.members.every(member => member.expert === undefined))
  assert.equal(team.members[0].executionPrompt, 'Keep guidance')
})

test('inline member rows resolve individual experts independently without a whole agency roster', async t => {
  const f = await fixture(t)
  await f.call('agent_teams_create', { name: 'Mixed roster', approval: 'required', plan: {
    members: [{ name: 'builder', role: 'engineer', expert: 'engineer' }, { name: 'ordinary', role: 'writer', expert: 'designer' }],
    tasks: [{ id: 'draft', subject: 'Draft', assignee: 'builder' }],
  } })
  const team = await readTeam(f.root, 'mixed-roster')
  assert.deepEqual(team.members.map(member => member.expert), ['engineer', undefined])
  assert.match(team.members[0].executionPrompt, /Persona: engineer/)
  assert.deepEqual(f.calls, ['engineer'])
})
