/**
 * agency-agents 桥（步 4 A 段）的行为测试。
 *
 * 全部用 stub 服务：三个服务由 `makeServices()` 现场造，ctx 只是一个 `get(name)`，
 * 因此**任何情况下都不会碰到真实的 agency-agents 插件**（活体验收由 captain 执行）。
 *
 * 覆盖（对应 acceptance）：
 * 1. 三服务任一缺失 → available:false + 缺席清单；全能 services 缺方法也回落；
 * 2. inject 数组与源码里没有任何 agency 服务名（只读依赖，照 valueRouterOf 模式）；
 * 3. 成员装配：name=expertSlug、重复 -2 后缀、路由三字段留空、executionPrompt 三段合成；
 * 4. 回落矩阵：team 不存在（列出可用 id）/ persona 缺失兜底 / 超 8000 截断 / 超 maxMembers 报错；
 * 5. 冲突矩阵：×profile 报错、×plan.members 报错、×plan.tasks 允许；
 * 6. 服务全缺时既有工具与 usage 段无回归。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

import {
  AGENCY_SERVICE_KEYS,
  DEFAULT_LOCALE,
  PERSONA_MAX_CHARS,
  agencyServicesOf,
  agencyUnavailableReason,
  assembleAgencyTeam,
  clientLocaleOf,
  composeExecutionPrompt,
  loadAgencyTeam,
  normalizeAgencyPlanTasks,
  resolveAgencyCreateRequest,
  resolveAgencyTeam,
} from '../lib/agency-bridge.js'
import { usageSectionText } from '../lib/index.js'
import { registerAgentTeamsTools } from '../lib/tools.js'
import { parseProfileInvocation } from '../lib/profiles.js'
import { buildActivationDirective, parseAgentTeamsLine } from '../lib/command.js'
import { TEAM_TOOL_NAMES } from '../lib/tool-names.js'

const SERVICE_NAMES = Object.values(AGENCY_SERVICE_KEYS)

/** A stub ctx whose `get` answers exactly the supplied service map. */
function ctxWith(services) {
  return { get: (key) => services[key] }
}

/** Build the three stub services from fixtures (真实形状：异步 snapshot/get/catalog、persona 返回 {prompt}). */
function makeServices(options = {}) {
  const teams = options.teams ?? []
  const experts = options.experts ?? []
  const personas = options.personas ?? {}
  const missingMethods = options.missingMethods ?? []
  const calls = { getPrompt: [], catalog: 0, snapshot: 0 }
  const teamsService = {
    snapshot: async () => { calls.snapshot += 1; return { teams, enabledTeams: teams.map((team) => team.id), revision: 1 } },
    get: async (id) => {
      const team = teams.find((candidate) => candidate.id === id)
      if (team === undefined) throw new Error(`专家团不存在，请重新选择。`)
      return team
    },
  }
  const libraryService = { catalog: async () => { calls.catalog += 1; return { experts, enabled: [], revision: 1 } } }
  const personaService = {
    getPrompt: async (slug, division, locale) => {
      calls.getPrompt.push({ slug, division, locale })
      if (options.throwGetPrompt === true) throw new Error('persona boom')
      const prompt = personas[slug]
      return prompt === undefined ? undefined : { prompt }
    },
  }
  const built = {
    [AGENCY_SERVICE_KEYS.teams]: teamsService,
    [AGENCY_SERVICE_KEYS.library]: libraryService,
    [AGENCY_SERVICE_KEYS.persona]: personaService,
  }
  for (const key of missingMethods) {
    if (key === AGENCY_SERVICE_KEYS.teams) delete built[AGENCY_SERVICE_KEYS.teams].snapshot
    else delete built[key].catalog ?? delete built[key].getPrompt
  }
  return { services: built, calls }
}

const DEMO_TEAM = {
  id: 'growth-squad',
  name: 'Growth Squad',
  goal: 'Ship the growth experiment end to end',
  constraints: 'Never ship behind a flag nobody owns',
  deliveryRequirements: 'Every claim carries a source URL',
  coordinatorPrompt: 'You coordinate this squad; synthesize, do not redo their work.',
  members: [
    { expertSlug: 'growth-hacker', duty: 'Design the experiment', instructions: 'Prefer reversible changes' },
    { expertSlug: 'data-analyst', duty: 'Read the funnel data' },
  ],
}
const DEMO_EXPERTS = [
  { slug: 'growth-hacker', division: 'marketing' },
  { slug: 'data-analyst', division: 'data' },
]

test('三服务任一缺失 → available:false 并列出缺席服务', () => {
  // Remove one service at a time: each must be reported as absent.
  for (const name of SERVICE_NAMES) {
    const services = {}
    for (const other of SERVICE_NAMES) {
      if (other !== name) services[other] = { snapshot: async () => ({ teams: [] }), catalog: async () => ({ experts: [] }), getPrompt: async () => undefined }
    }
    const outcome = agencyServicesOf(ctxWith(services))
    assert.equal(outcome.available, false, `missing ${name} must be unavailable`)
    assert.deepEqual(outcome.missing, [name])
    assert.match(agencyUnavailableReason(outcome), new RegExp(name))
  }
  // Nobody registered anything at all (the ordinary case).
  const empty = agencyServicesOf(ctxWith({}))
  assert.equal(empty.available, false)
  assert.deepEqual(empty.missing, SERVICE_NAMES)
  assert.equal(agencyServicesOf(undefined).available, false)
})

test('服务在但最小方法集不全 → 整体回落，且与"缺席"分开报告', () => {
  const shapes = [
    // 三个服务都注册了，但都是空对象（没有任何可用方法）→ unrecognized。
    {
      [AGENCY_SERVICE_KEYS.teams]: {},
      [AGENCY_SERVICE_KEYS.library]: {},
      [AGENCY_SERVICE_KEYS.persona]: {},
    },
    // 只有一部分服务形状可用 → 缺失的进 unrecognized。
    {
      [AGENCY_SERVICE_KEYS.teams]: { snapshot: async () => ({ teams: [] }) },
      [AGENCY_SERVICE_KEYS.library]: {},
      [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => undefined },
    },
  ]
  for (const services of shapes) {
    const outcome = agencyServicesOf(ctxWith(services))
    assert.equal(outcome.available, false, `shape ${JSON.stringify(Object.keys(services))} must fall back`)
    assert.deepEqual(outcome.missing, [], 'present-but-wrong-shape is not a missing service')
    assert.ok(outcome.unrecognized.length > 0, 'unrecognized shape is reported separately')
    assert.match(agencyUnavailableReason(outcome), /unrecognized shape/)
  }
  // A get-only teams service (no snapshot/list) is still a usable lookup.
  const getOnly = {
    [AGENCY_SERVICE_KEYS.teams]: { get: async () => DEMO_TEAM },
    [AGENCY_SERVICE_KEYS.library]: { catalog: async () => ({ experts: [] }) },
    [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => undefined },
  }
  assert.equal(agencyServicesOf(ctxWith(getOnly)).available, true)
  const full = makeServices({ teams: [DEMO_TEAM], experts: DEMO_EXPERTS, personas: {} })
  assert.equal(agencyServicesOf(ctxWith(full.services)).available, true)
})

test('回归：agency-agents 1.0.11 的真实形状（异步 snapshot/get/catalog、persona 返回 {prompt}）', async () => {
  // 这正是活体走查暴露的缺陷形状：没有 list()、catalog 是异步、persona 是对象。
  // 老实现按「同步 list/catalog + 裸字符串 persona」写，单测全绿但活体整体回落。
  const { services, calls } = makeServices({
    teams: [DEMO_TEAM, { id: 'team-custom-2', name: '软件开发团' }],
    experts: DEMO_EXPERTS,
    personas: { 'growth-hacker': 'You are a growth hacker.', 'data-analyst': 'You read funnels.' },
  })
  const handle = agencyServicesOf(ctxWith(services))
  assert.equal(handle.available, true, 'real 1.0.11 shape must be recognized')

  // 按 id、按 name 都能取到（name 匹配走 snapshot 的全量清单）。
  const byId = await resolveAgencyTeam(handle.services, 'growth-squad')
  assert.equal(byId.ok, true)
  const byName = await resolveAgencyTeam(handle.services, '软件开发团')
  assert.equal(byName.ok, true)
  assert.equal(byName.ok ? byName.team.id : '', 'team-custom-2')

  // 未知 id：get() 抛错被吞掉，报错里带可用清单（不静默回落）。
  const missingTeam = await resolveAgencyTeam(handle.services, 'nope')
  assert.equal(missingTeam.ok, false)
  assert.match(missingTeam.reason ?? missingTeam.error, /available teams: growth-squad/)
  assert.match(missingTeam.ok === false ? missingTeam.error : '', /team-custom-2/)

  // 装配：persona 从 {prompt} 取正文、division 来自异步 catalog。
  const assembled = await assembleAgencyTeam({
    services: handle.services,
    team: DEMO_TEAM,
    maxMembers: 8,
    locale: 'zh',
  })
  assert.equal(assembled.ok, true)
  const members = assembled.ok ? assembled.result.members : []
  assert.equal(members.length, 2)
  assert.match(members[0].executionPrompt, /You are a growth hacker\./)
  assert.deepEqual(calls.getPrompt.map((call) => call.division), ['marketing', 'data'])
  assert.equal(calls.catalog, 1, 'catalog is awaited once')
})

test('loadAgencyTeam 服务缺席时给出可读原因且不抛错', async () => {
  const outcome = await loadAgencyTeam({ ctx: ctxWith({}), idOrName: 'growth-squad', maxMembers: 8, locale: 'zh' })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.available, false)
  assert.match(outcome.reason, /agency-agents bridge is unavailable/)
  for (const name of SERVICE_NAMES) assert.ok(outcome.reason.includes(name))
})

test('inject 数组与源码均不声明任何 agency 服务', async () => {
  const index = await readFile(fileURLToPath(new URL('../src/index.ts', import.meta.url)), 'utf8')
  const tools = await readFile(fileURLToPath(new URL('../src/tools.ts', import.meta.url)), 'utf8')
  const bridge = await readFile(fileURLToPath(new URL('../src/agency-bridge.ts', import.meta.url)), 'utf8')
  for (const [where, source] of [['index.ts', index], ['tools.ts', tools], ['agency-bridge.ts', bridge]]) {
    assert.equal(/export const inject\s*=/.test(source) && /inject\s*[:=]\s*\[[^\]]*agency/i.test(source), false, `${where} must not declare agency services in inject`)
    assert.equal(/ctx\.inject\s*\(/.test(source) && /ctx\.inject\s*\(\s*\[[^\]]*agency/i.test(source), false, `${where} must not lazy-inject agency services`)
  }
  // The exported inject array is still exactly the documented five.
  const { inject } = await import('../lib/index.js')
  assert.deepEqual(inject, ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'])
  for (const name of SERVICE_NAMES) assert.equal(inject.includes(name), false)
  // No source file wires an agency service into Cordis' inject machinery — the
  // only places `inject` may appear next to a service name are these two records.
  for (const [where, source] of [['index.ts', index], ['tools.ts', tools], ['agency-bridge.ts', bridge]]) {
    for (const name of SERVICE_NAMES) {
      assert.equal(
        new RegExp(`inject[^\n]{0,120}${name}`, 'i').test(source),
        false,
        `${where}: "${name}" must not appear inside an inject declaration`,
      )
      assert.equal(
        new RegExp(`get\\(\\s*['"]${name}['"]`).test(source),
        false,
        `${where}: "${name}" is reached through the key constant, not a literal`,
      )
    }
  }
  // Detection goes through ctx.get with the shared key constants.
  assert.ok(bridge.includes('ctx.get(key as never)'), 'bridge probes with ctx.get')
  assert.ok(tools.includes('loadAgencyTeam'), 'tools.ts consumes the bridge')
  // index.ts keeps its own lazy inject list narrow (see AGENTS: commands only).
  assert.ok(index.includes("ctx.inject(['commands']"), 'index.ts keeps its documented lazy inject')
  assert.equal(/ctx\.inject\(\[[^\]]*commands[^\]]*agency/i.test(index), false)
})

test('按 id 或 name 都能取到团队', async () => {
  const { services } = makeServices({ teams: [DEMO_TEAM], experts: DEMO_EXPERTS })
  const handle = agencyServicesOf(ctxWith(services))
  assert.equal(handle.available, true)
  const handleServices = handle.available ? handle.services : undefined
  assert.equal((await resolveAgencyTeam(handleServices, 'growth-squad')).ok, true)
  assert.equal((await resolveAgencyTeam(handleServices, 'Growth Squad')).ok, true)
  assert.equal((await resolveAgencyTeam(handleServices, '')).ok, false)
})

test('team 不存在 → 报错并列出可用 id（不静默回落）', async () => {
  const { services } = makeServices({ teams: [DEMO_TEAM, { id: 'second', name: 'Second' }], experts: DEMO_EXPERTS })
  const outcome = await loadAgencyTeam({ ctx: ctxWith(services), idOrName: 'nope', maxMembers: 8, locale: 'zh' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /unknown agency team "nope"/)
  assert.match(outcome.reason, /available teams: growth-squad/)
  assert.match(outcome.reason, /second/)
})

test('成员装配：name=expertSlug、路由三字段留空、executionPrompt 三段合成', async () => {
  const personas = {
    'growth-hacker': 'You are a growth hacker.',
    'data-analyst': 'You are a data analyst.',
  }
  const { services, calls } = makeServices({ teams: [DEMO_TEAM], experts: DEMO_EXPERTS, personas })
  const outcome = await loadAgencyTeam({ ctx: ctxWith(services), idOrName: 'growth-squad', maxMembers: 8, locale: 'zh' })
  assert.equal(outcome.ok, true)
  const { members, diagnostics } = outcome.ok ? outcome.assembly : { members: [], diagnostics: [] }
  assert.deepEqual(members.map((member) => member.name), ['growth-hacker', 'data-analyst'])
  for (const member of members) {
    // The route stays empty: the value router fills it from task difficulty.
    assert.equal(member.provider, undefined)
    assert.equal(member.model, undefined)
    assert.equal(member.reasoningEffort, undefined)
    assert.equal(member.diagnostics.length, 0)
  }
  assert.equal(diagnostics.length, 0)
  const growth = members[0]
  assert.equal(growth.executionPrompt, 'You are a growth hacker.\n\n## 本次职责\nDesign the experiment\n\n## 补充指令\nPrefer reversible changes')
  // Second member has no instructions: the trailing section is omitted whole.
  assert.equal(members[1].executionPrompt, 'You are a data analyst.\n\n## 本次职责\nRead the funnel data')
  // Each expert's persona is read once, with the catalog division, at the requested locale.
  assert.equal(calls.catalog, 1, 'catalog is read once, not per member')
  assert.deepEqual(calls.getPrompt.map((call) => [call.slug, call.division, call.locale]), [
    ['growth-hacker', 'marketing', 'zh'],
    ['data-analyst', 'data', 'zh'],
  ])
})

test('重复 expertSlug → -2 后缀 + diagnostics，persona 仍按原 slug 读', async () => {
  const team = {
    id: 'dup',
    name: 'Dup',
    members: [
      { expertSlug: 'reviewer', duty: 'First pass' },
      { expertSlug: 'reviewer', duty: 'Second pass' },
      { expertSlug: 'reviewer', duty: 'Third pass' },
    ],
  }
  const { services, calls } = makeServices({ teams: [team], experts: [{ slug: 'reviewer', division: 'engineering' }], personas: { reviewer: 'Review persona' } })
  const outcome = await loadAgencyTeam({ ctx: ctxWith(services), idOrName: 'dup', maxMembers: 8, locale: 'zh' })
  assert.equal(outcome.ok, true)
  const assembly = outcome.ok ? outcome.assembly : { members: [], diagnostics: [] }
  assert.deepEqual(assembly.members.map((member) => member.name), ['reviewer', 'reviewer-2', 'reviewer-3'])
  const collisions = assembly.diagnostics.filter((entry) => entry.code === 'name-collision')
  assert.equal(collisions.length, 2)
  assert.match(collisions[0].detail, /"reviewer" appears 2 times/)
  // Renaming must not change how the persona is fetched.
  assert.deepEqual([...new Set(calls.getPrompt.map((call) => call.slug))], ['reviewer'])
  assert.equal(assembly.members[1].executionPrompt, 'Review persona\n\n## 本次职责\nSecond pass')
})

test('persona 缺失 → duty + instructions 兜底并记 diagnostics', async () => {
  const team = { id: 't', name: 'T', members: [{ expertSlug: 'solo', duty: 'Own the rollout', instructions: 'Report blockers early' }] }
  const { services } = makeServices({ teams: [team], experts: [{ slug: 'solo', division: 'ops' }], personas: {} })
  const outcome = await loadAgencyTeam({ ctx: ctxWith(services), idOrName: 't', maxMembers: 8, locale: 'zh' })
  assert.equal(outcome.ok, true)
  const assembly = outcome.ok ? outcome.assembly : { members: [], diagnostics: [] }
  assert.equal(assembly.members[0].executionPrompt, '## 本次职责\nOwn the rollout\n\n## 补充指令\nReport blockers early')
  const missing = assembly.diagnostics.filter((entry) => entry.code === 'persona-missing')
  assert.equal(missing.length, 1)
  assert.equal(missing[0].member, 'solo')
  assert.match(missing[0].detail, /falling back to duty \+ instructions/)
})

test('persona 超 8000 字符 → 截断并记 diagnostics', async () => {
  const long = 'x'.repeat(PERSONA_MAX_CHARS + 500)
  const team = { id: 't', name: 'T', members: [{ expertSlug: 'big', duty: 'Do it' }] }
  const { services } = makeServices({ teams: [team], experts: [{ slug: 'big', division: 'ops' }], personas: { big: long } })
  const outcome = await loadAgencyTeam({ ctx: ctxWith(services), idOrName: 't', maxMembers: 8, locale: 'zh' })
  assert.equal(outcome.ok, true)
  const assembly = outcome.ok ? outcome.assembly : { members: [], diagnostics: [] }
  const prompt = assembly.members[0].executionPrompt
  assert.ok(prompt.startsWith('x'.repeat(PERSONA_MAX_CHARS)), 'truncated exactly at the cap')
  assert.ok(prompt.includes('## 本次职责\nDo it'))
  const truncated = assembly.diagnostics.filter((entry) => entry.code === 'persona-truncated')
  assert.equal(truncated.length, 1)
  assert.match(truncated[0].detail, new RegExp(`${PERSONA_MAX_CHARS + 500} chars; truncated to ${PERSONA_MAX_CHARS}`))
})

test('阵容超 maxMembers → 明确报错，不静默截断', async () => {
  const team = {
    id: 't',
    name: 'Big Team',
    members: [
      { expertSlug: 'a' }, { expertSlug: 'b' }, { expertSlug: 'c' },
    ],
  }
  const { services } = makeServices({ teams: [team], experts: [], personas: {} })
  const outcome = await loadAgencyTeam({ ctx: ctxWith(services), idOrName: 't', maxMembers: 2, locale: 'zh' })
  assert.equal(outcome.ok, false)
  assert.match(outcome.reason, /has 3 members but maxMembers is 2/)
  assert.match(outcome.reason, /never silently truncated/)
  assert.match(outcome.reason, /raise the plugin's maxMembers config/)
})

test('locale 缺省回落到 zh，客户端有值时用客户端值', () => {
  assert.equal(clientLocaleOf(undefined), undefined)
  assert.equal(clientLocaleOf({ get: () => undefined }), undefined)
  assert.equal(clientLocaleOf({ get: () => ({}) }), undefined)
  assert.equal(clientLocaleOf({ get: () => ({ getLocale: () => ({ active: 'en' }) }) }), 'en')
  assert.equal(clientLocaleOf({ get: () => ({ getLocale: () => ({ active: '  ja  ' }) }) }), 'ja')
  assert.equal(clientLocaleOf({ get: () => ({ getLocale: () => ({}) }) }), undefined)
  // A throwing service must not break team creation.
  assert.equal(clientLocaleOf({ get: () => ({ getLocale: () => { throw new Error('boom') } }) }), undefined)
  const { services, calls } = makeServices({ teams: [DEMO_TEAM], experts: DEMO_EXPERTS, personas: {} })
  // The default constant is what the tool layer falls back to.
  assert.equal(DEFAULT_LOCALE, 'zh')
  const handle = agencyServicesOf(ctxWith(services))
  assert.equal(handle.available, true)
  assert.equal(assembleAgencyTeam instanceof Function, true)
  assert.equal(calls.catalog, 0)
})

test('composeExecutionPrompt 缺段即省略，不补占位符', () => {
  assert.equal(composeExecutionPrompt(undefined, 'd', 'i'), '## 本次职责\nd\n\n## 补充指令\ni')
  assert.equal(composeExecutionPrompt('p'), 'p')
  assert.equal(composeExecutionPrompt('p', '', ''), 'p')
  assert.equal(composeExecutionPrompt(undefined), '')
})

test('冲突矩阵：×profile 报错 / ×plan.members 报错 / ×plan.tasks 允许', () => {
  const planTasks = [{ id: 'a', subject: 'Do A' }]
  const profileConflict = resolveAgencyCreateRequest({ agencyTeam: 'growth-squad', profile: 'demo' })
  assert.equal(profileConflict.ok, false)
  assert.match(profileConflict.error, /choose either agencyTeam or a configured profile/)

  const membersConflict = resolveAgencyCreateRequest({ agencyTeam: 'growth-squad', plan: { members: [{ name: 'x' }] } })
  assert.equal(membersConflict.ok, false)
  assert.match(membersConflict.error, /omit plan\.members/)

  const tasksAllowed = resolveAgencyCreateRequest({ agencyTeam: 'growth-squad', plan: { tasks: planTasks } })
  assert.equal(tasksAllowed.ok, true)
  assert.equal(tasksAllowed.agencyTeam, 'growth-squad')

  // Neither given → the ordinary captain-assembles path, nothing rejected.
  assert.equal(resolveAgencyCreateRequest({}).ok, true)
  assert.equal(resolveAgencyCreateRequest({ agencyTeam: '   ' }).ok, true)
  // Blank optional strings count as omissions (issue #99 habit).
  assert.equal(resolveAgencyCreateRequest({ agencyTeam: 'growth-squad', profile: '  ' }).ok, true)
  assert.equal(resolveAgencyCreateRequest({ agencyTeam: 'growth-squad', plan: { tasks: planTasks } }).ok, true)
})

test('plan.tasks 与 agencyTeam 共存时被标准化（路由意图 + 拓扑排序 + 环检测）', () => {
  const rows = normalizeAgencyPlanTasks([
    { id: 'b', subject: 'Second', dependencies: ['a'] },
    { id: 'a', subject: 'First' },
  ])
  // Dependency order wins over the authored one.
  assert.deepEqual(rows.map((row) => row.id), ['a', 'b'])
  assert.equal(rows[0].difficulty, 'medium', 'absent difficulty takes the shared default')
  assert.equal(rows[0].role, 'general')
  assert.equal(rows[0].normalizedRole, 'general')
  assert.equal(rows[0].route, undefined)
  const explicit = normalizeAgencyPlanTasks([{ id: 'x', subject: 'S', difficulty: 'high', role: ' Code  Reviewer ' }])[0]
  assert.equal(explicit.difficulty, 'high')
  assert.equal(explicit.role, 'Code  Reviewer')
  assert.equal(explicit.normalizedRole, 'code reviewer')
  // Malformed rows are rejected rather than silently repaired.
  assert.throws(() => normalizeAgencyPlanTasks([{ id: 'x' }]), /\[0\]\.subject must be a string/)
  assert.throws(() => normalizeAgencyPlanTasks([{ id: 'x', subject: 'S', difficulty: 'urgent' }]), /invalid difficulty/)
  assert.throws(() => normalizeAgencyPlanTasks([{ id: 'x', subject: 'S', dependencies: ['nope'] }]), /depends on unknown task/)
  assert.throws(() => normalizeAgencyPlanTasks([{ id: 'x', subject: 'S', dependencies: ['x'] }]), /dependency cycle/)
  assert.throws(() => normalizeAgencyPlanTasks([{ id: 'x', subject: 'S' }, { id: 'X', subject: 'S' }]), /collapse to the same task id/)
  assert.deepEqual(normalizeAgencyPlanTasks([]), [])
})

test('--agency 斜杠入口解析成型，与 --profile 互斥', () => {
  const bare = parseAgentTeamsLine('--agency growth-squad ship it')
  assert.equal(bare.agency, 'growth-squad')
  assert.equal(bare.goal, 'ship it')
  assert.equal(bare.profile, undefined)
  assert.equal(parseAgentTeamsLine('--agency=growth-squad goal').agency, 'growth-squad')
  assert.equal(parseAgentTeamsLine('agency=growth-squad goal').agency, 'growth-squad')
  // A mid-sentence flag stays inside the goal.
  assert.equal(parseAgentTeamsLine('research agency=prod config').agency, undefined)
  assert.equal(parseAgentTeamsLine('research agency=prod config').goal, 'research agency=prod config')
  // Existing profile parsing is untouched.
  assert.equal(parseProfileInvocation('--profile demo ship it').profile, 'demo')
  // Agency + profile together is rejected; so is a repeat or valueless flag.
  assert.throws(() => parseAgentTeamsLine('--profile demo --agency team x'), /choose either --profile or --agency/)
  assert.throws(() => parseAgentTeamsLine('--agency a --agency b x'), /duplicate AgentTeams agency flag/)
  assert.throws(() => parseAgentTeamsLine('--agency'), /missing a team id or name/)
  assert.throws(() => parseAgentTeamsLine('--agency=') , /missing a team id or name/)
  const directive = buildActivationDirective('ship it', undefined, 'seed', 'growth-squad')
  assert.match(directive, /agencyTeam="growth-squad"/)
  assert.match(directive, /supplies the whole roster/)
  assert.match(directive, /coordinator briefing/)
  // No agency → the directive keeps its existing shape.
  assert.equal(buildActivationDirective('ship it').includes('agencyTeam='), false)
})

test('服务全缺时既有工具与 usage 段无回归', () => {
  const definitions = []
  registerAgentTeamsTools({
    on: () => () => {},
    effect: (setup) => setup(),
    logger: { warn: () => {}, debug: () => {} },
    tools: { register: (definition) => definitions.push(definition) },
    subagents: {
      followup: async () => {}, start: async () => ({}), startContinuable: async () => ({}),
      sendMessage: async () => {},
      registerContinuableSetup: () => () => {},
    },
    get: () => undefined,
  }, { stateDir: '.agent-teams', memberProvider: 'spawn', memberMaxDepth: 0, maxMembers: 8, profiles: {} })
  const byName = new Map(definitions.map((definition) => [definition.name, definition]))
  // All fourteen tool names still register, and their names are unchanged.
  assert.equal(definitions.length, TEAM_TOOL_NAMES.length)
  for (const name of TEAM_TOOL_NAMES) assert.ok(byName.has(name), `${name} is not registered`)

  const create = byName.get('agent_teams_create')
  const properties = create.parameters.properties
  assert.ok(properties.agencyTeam !== undefined, 'agencyTeam parameter is exposed')
  assert.equal(properties.agencyTeam.type, 'string')
  assert.match(properties.agencyTeam.description, /mutually exclusive with profile/)
  // Existing parameters keep their descriptions.
  assert.match(properties.name.description, /Name for the new team/)
  assert.equal(create.parameters.properties.plan.properties.tasks.items.properties.difficulty.enum.length, 4)

  // The usage section is unchanged apart from the (step-3) scoring card.
  const text = usageSectionText(TEAM_TOOL_NAMES.join(', '))
  assert.match(text, /^AgentTeams captain protocol:\n/)
  assert.ok(text.includes('Difficulty scoring card'))
  assert.ok(text.includes(`Tools: ${TEAM_TOOL_NAMES.join(', ')}`))
  assert.equal(text.includes('agencyTeam'), false, 'usage text stays unaware of the optional bridge')
})

test('回归：分派路径一律在创建时冻结成员线路（agency 与 profile 同契约）', async () => {
  // 2026-10-09 观察项：initializeAgencyTeam 的选路循环在 `if (!input.staged)`
  // 守卫之外。核对 initializeProfileTeam 后确认这是**刻意**的——两条路径必须
  // 写出同一形状的成员记录，且「成员线路创建时冻结」是既定硬约束；暂存团队在
  // 批准时由 approveStagedTeam 按任务难度重锚。这条断言钉住该语义，防止有人
  // 把循环挪进守卫（那会让暂存成员没有线路，两条路径形状分叉）。
  const source = await readFile(fileURLToPath(new URL('../src/tools.ts', import.meta.url)), 'utf8')
  for (const [label, fn] of [['initializeAgencyTeam', /async function initializeAgencyTeam/], ['initializeProfileTeam', /async function initializeProfileTeam/]]) {
    const start = source.search(fn)
    assert.ok(start > 0, `${label} must exist`)
    const body = source.slice(start, source.indexOf('\n}\n', start))
    // 守卫内的解析 + 守卫外的冻结循环，两者都在同一函数体内。
    assert.match(body, /if \(!input\.staged\) \{/, `${label}: staged guard present`)
    assert.match(body, /member\.routeKey = memberReuseKey\(/, `${label}: routeKey is frozen on creation`)
    assert.match(body, /member\.provider = selection\.provider/, `${label}: provider is frozen on creation`)
    // 守卫只包住解析/编成，不能包住冻结循环。
    const guardEnd = body.indexOf('}', body.indexOf('applyMemberRoutePins(draft)'))
    const freezeAt = body.indexOf('member.routeKey = memberReuseKey(')
    assert.ok(freezeAt > guardEnd, `${label}: the freeze loop must stay outside the staged guard`)
  }
})
