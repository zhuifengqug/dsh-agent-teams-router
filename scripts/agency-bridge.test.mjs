/**
 * agency-agents 桥（步 4 A 段）的行为测试。
 *
 * 全部用 stub 服务：三个服务由 `makeServices()` 现场造，ctx 只是一个 `get(name)`，
 * 因此**任何情况下都不会碰到真实的 agency-agents 插件**（活体验收由 captain 执行）。
 *
 * 覆盖（对应 acceptance）：
 * 1. 三服务任一缺失 → available:false + 缺席清单；全能 services 缺方法也回落；
 * 2. inject 数组与源码里没有任何 agency 服务名（只读依赖，照 `agencyServicesOf()` 模式）；
 * 3. 成员装配：name=expertSlug、重复 -2 后缀、模型三字段留空（由创建时冻结循环填）、
 *    executionPrompt 三段合成；
 * 4. 回落矩阵：team 不存在（列出可用 id）/ persona 缺失兜底 / 超 8000 截断 / 超 maxMembers 报错；
 * 5. 冲突矩阵：×profile 报错、×plan.members 报错、×plan.tasks 允许；
 * 6. 服务全缺时既有工具与 usage 段无回归。
 *
 * ## 2026-10-10 去路由退役（本文件两处改写）
 *
 * 用户裁决把「任务难度 → 外部路由服务自动决定成员模型」整套机制退役了：
 * 任务不再有 `route`/`resolvedRoute`，成员不再有 `routeKey`/`difficulty`/
 * `normalizedRole`，`memberReuseKey` / `applyMemberRoutePins` / `planMemberSlots`
 * 等已从 `src/tools.ts` 删除。本文件据此删除/改写了以下内容：
 * - 删除原「分派路径一律在创建时冻结成员线路」用例中依赖 `memberReuseKey` /
 *   `applyMemberRoutePins` / `member.routeKey` 的断言，改为钉住**仍然有效**的部分：
 *   两条创建路径共用同一个写盘前的「解析成员线路 → 对照 provider 目录校验」冻结循环，
 *   且该循环不被 created-staged 分支包住（两种创建方式写出同一形状的成员记录）。
 * - `name` 参数描述已随本次改造改为中文，断言随之更新为当前描述文案。
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
  listAgencyExperts,
  listEnabledExperts,
  loadAgencyTeam,
  normalizeAgencyPlanTasks,
  resolveAgencyCreateRequest,
  resolveAgencyTeam,
  resolveExpertPersona,
  resolveOptionalExpertPersona,
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
  const libraryService = { catalog: async () => { calls.catalog += 1; return { experts, enabled: options.enabled ?? [], revision: 1 } } }
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
  // Existing parameters keep their descriptions. The team-name description gained the
  // language requirement (2026-10-10 中文化约束), so match its unchanged lead only.
  assert.match(properties.name.description, /Team name \(used as its stable id\)/)
  assert.equal(create.parameters.properties.plan.properties.tasks.items.properties.difficulty.enum.length, 4)

  // 去路由（2026-10-10）：计划里的**任务行**不再暴露线路字段——难度/角色只做展示；
  // 成员行仍暴露 provider/model/reasoning_effort，因为成员模型改由用户在面板选定。
  const taskKeys = Object.keys(create.parameters.properties.plan.properties.tasks.items.properties)
  for (const retired of ['provider', 'model', 'reasoning_effort']) {
    assert.equal(taskKeys.includes(retired), false, `task rows must not expose the retired route field ${retired}`)
  }
  const memberKeys = Object.keys(create.parameters.properties.plan.properties.members.items.properties)
  for (const kept of ['provider', 'model', 'reasoning_effort']) {
    assert.equal(memberKeys.includes(kept), true, `member rows keep ${kept}: the user picks each member's model`)
  }

  // The usage section is unchanged apart from the (step-3) scoring card.
  const text = usageSectionText(TEAM_TOOL_NAMES.join(', '))
  assert.match(text, /^AgentTeams captain protocol:\n/)
  assert.ok(text.includes('Difficulty scoring card'))
  assert.ok(text.includes(`Tools: ${TEAM_TOOL_NAMES.join(', ')}`))
  assert.equal(text.includes('agencyTeam'), false, 'usage text stays unaware of the optional bridge')
})

test('回归：两条创建路径共用同一个「解析成员线路 → 校验」冻结循环（且不被 staged 分支包住）', async () => {
  // 2026-10-09 观察项：initializeAgencyTeam 的选路循环在 `if (!input.staged)` 守卫
  // 之外。核对 initializeProfileTeam 后确认这是**刻意**的——两条路径必须写出同一
  // 形状的成员记录，且「成员线路在创建时冻结」是既定硬约束。
  //
  // 2026-10-10 去路由：`if (!input.staged)` 守卫本身、`memberReuseKey` 派生的
  // `member.routeKey` 冻结、以及 `applyMemberRoutePins(draft)` 都已随退役删除，
  // 原断言不再有对象。仍然有效、也仍然值得钉住的是它的**内核**：两条路径共用同一个
  // 写盘前的冻结循环（resolveMemberLlmSelection → validateMemberLlmSelections），
  // 且该循环不被任何 staged 条件分支包住——否则暂存团队成员会没有线路，两条路径
  // 形状分叉。同时钉住：任务行不再写任何线路字段。
  const source = await readFile(fileURLToPath(new URL('../src/tools.ts', import.meta.url)), 'utf8')
  for (const [label, fn] of [['initializeAgencyTeam', /async function initializeAgencyTeam/], ['initializeProfileTeam', /async function initializeProfileTeam/]]) {
    const start = source.search(fn)
    assert.ok(start > 0, `${label} must exist`)
    const body = source.slice(start, source.indexOf('\n}\n', start))

    // 共享的冻结循环：三个成员线路字段都被写死成一个具体值。
    assert.match(body, /member\.provider = selection\.provider/, `${label}: provider is frozen on creation`)
    assert.match(body, /member\.model = selection\.model/, `${label}: model is frozen on creation`)
    assert.match(body, /member\.reasoningEffort = selection\.reasoningEffort/, `${label}: effort is frozen on creation`)
    // 冻结发生在对照 provider 目录校验之前，顺序不得倒置。
    const freezeAt = body.indexOf('member.provider = selection.provider')
    const validateAt = body.indexOf('await validateMemberLlmSelections(')
    assert.ok(validateAt > freezeAt, `${label}: selections must be validated after the freeze loop`)

    // staged 只决定落盘的 phase 标记（一个三元表达式），不得包住冻结循环。
    const stagedAt = body.indexOf("...input.staged ? { phase: 'staged'")
    assert.ok(stagedAt > 0, `${label}: the staged phase marker is still written`)
    assert.ok(stagedAt < freezeAt, `${label}: the freeze loop must run for staged creation too`)
    assert.equal(body.includes('if (!input.staged) {'), false, `${label}: the retired staged guard must be gone`)

    // 退役面：任务行与函数体里都不再出现任何线路字段。
    for (const retired of ['member.routeKey', 'memberReuseKey', 'applyMemberRoutePins', 'resolvedRoute', 'routeAudit', 'routeStatus']) {
      assert.equal(body.includes(retired), false, `${label}: retired route symbol ${retired} must be gone`)
    }
  }
})

test('队员级专家：完整清单保留 disabled，个人服务不依赖 teams，发现阶段零 persona 读取', async () => {
  const experts = [
    { slug: 'growth-hacker', division: 'marketing', description: 'Design growth experiments' },
    { slug: 'data-analyst', division: 'data', description: 'Read funnel data' },
    { slug: 'plain' },
  ]
  const { services, calls } = makeServices({
    experts,
    enabled: ['data-analyst', 'not-in-catalog'],
    personas: { 'data-analyst': 'You read funnels.' },
  })
  delete services[AGENCY_SERVICE_KEYS.teams]
  const queried = []
  const ctx = { get: (key) => { queried.push(key); return services[key] } }
  const listed = await listAgencyExperts(ctx)
  assert.deepEqual(listed, {
    available: true,
    experts: [
      { slug: 'growth-hacker', division: 'marketing', description: 'Design growth experiments', enabled: false },
      { slug: 'data-analyst', division: 'data', description: 'Read funnel data', enabled: true },
      { slug: 'plain', division: '', description: '', enabled: false },
    ],
  })
  assert.deepEqual(queried, [AGENCY_SERVICE_KEYS.library])
  assert.equal(calls.catalog, 1, '完整清单仅取一次 catalog')
  assert.equal(calls.snapshot, 0, '个人发现不读取团队清单')
  assert.deepEqual(calls.getPrompt, [], '发现清单不预加载 persona')

  const enabled = await listEnabledExperts(ctx)
  assert.deepEqual(enabled, {
    available: true,
    experts: [{ slug: 'data-analyst', division: 'data', description: 'Read funnel data' }],
  }, '旧接口只过滤 enabled，不改变行契约')
  assert.equal(calls.catalog, 2, '每次目录调用只读取一次')
  assert.deepEqual(calls.getPrompt, [])

  delete services[AGENCY_SERVICE_KEYS.persona]
  assert.deepEqual(await listAgencyExperts(ctx), listed, '只剩 library 时目录仍完整可用')
  assert.equal(calls.catalog, 3)
  assert.deepEqual(calls.getPrompt, [])
})

test('队员级专家：完整清单在缺服务、错形状和 catalog 调用失败时返回不可用', async () => {
  const cases = [
    undefined,
    ctxWith({}),
    ctxWith({
      [AGENCY_SERVICE_KEYS.library]: {},
      [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => ({ prompt: 'p' }) },
    }),
    ctxWith({
      [AGENCY_SERVICE_KEYS.library]: { catalog: async () => { throw new Error('catalog boom') } },
      [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => ({ prompt: 'p' }) },
    }),
    ctxWith({
      [AGENCY_SERVICE_KEYS.library]: { catalog: async () => ({ experts: DEMO_EXPERTS }) },
      [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => ({ prompt: 'p' }) },
    }),
    { get: () => { throw new Error('service boom') } },
  ]
  for (const ctx of cases) {
    const listed = await listAgencyExperts(ctx)
    assert.equal(listed.available, false)
    assert.equal(typeof listed.reason, 'string')
  }
})

test('队员级专家：可选解析未选择、unknown、disabled 时静默回落且不取 persona', async () => {
  const { services, calls } = makeServices({
    experts: DEMO_EXPERTS,
    enabled: ['data-analyst'],
    personas: { 'growth-hacker': 'Disabled persona', 'data-analyst': 'Enabled persona' },
  })
  delete services[AGENCY_SERVICE_KEYS.teams]
  let serviceReads = 0
  const ctx = { get: (key) => { serviceReads += 1; return services[key] } }
  assert.equal(await resolveOptionalExpertPersona({ ctx, locale: DEFAULT_LOCALE }), undefined)
  assert.equal(await resolveOptionalExpertPersona({ ctx, slug: '   ', locale: DEFAULT_LOCALE }), undefined)
  assert.equal(serviceReads, 0, '省略 slug 时不探测服务')
  assert.equal(calls.catalog, 0, '省略 slug 时不读取 catalog')

  assert.equal(await resolveOptionalExpertPersona({ ctx, slug: 'nobody', locale: DEFAULT_LOCALE }), undefined)
  assert.equal(await resolveOptionalExpertPersona({ ctx, slug: 'growth-hacker', locale: DEFAULT_LOCALE }), undefined)
  assert.equal(calls.catalog, 2, '明确 slug 每次只读取一个目录')
  assert.deepEqual(calls.getPrompt, [], '未知和停用专家不读取 persona')
  assert.equal(calls.snapshot, 0)
})

test('队员级专家：可选解析缺服务、调用错误、缺 persona 均静默 undefined 且无日志', async () => {
  const events = []
  const logger = new Proxy({}, { get: (_target, method) => (...args) => events.push({ method, args }) })
  const contexts = [undefined, ctxWith({}), { get: () => { throw new Error('service boom') } }]
  for (const absent of [AGENCY_SERVICE_KEYS.library, AGENCY_SERVICE_KEYS.persona]) {
    const { services } = makeServices({ experts: DEMO_EXPERTS, enabled: ['growth-hacker'] })
    delete services[absent]
    contexts.push(ctxWith(services))
  }
  contexts.push(ctxWith({
    [AGENCY_SERVICE_KEYS.library]: { catalog: async () => { throw new Error('catalog boom') } },
    [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => ({ prompt: 'p' }) },
  }))
  contexts.push(ctxWith({
    [AGENCY_SERVICE_KEYS.library]: { catalog: async () => ({ experts: DEMO_EXPERTS, enabled: [] }) },
    [AGENCY_SERVICE_KEYS.persona]: {},
  }))
  contexts.push(ctxWith({
    [AGENCY_SERVICE_KEYS.library]: { catalog: async () => ({ experts: DEMO_EXPERTS, enabled: ['growth-hacker'] }) },
    [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => { throw new Error('persona boom') } },
  }))
  for (const prompt of [undefined, {}, { prompt: '' }, { prompt: '   ' }]) {
    contexts.push(ctxWith({
      [AGENCY_SERVICE_KEYS.library]: { catalog: async () => ({ experts: DEMO_EXPERTS, enabled: ['growth-hacker'] }) },
      [AGENCY_SERVICE_KEYS.persona]: { getPrompt: async () => prompt },
    }))
  }
  for (const ctx of contexts) {
    const silent = ctx === undefined ? undefined : { ...ctx, logger }
    assert.equal(await resolveOptionalExpertPersona({ ctx: silent, slug: 'growth-hacker', locale: DEFAULT_LOCALE }), undefined)
  }
  assert.deepEqual(events, [], '回落路径不输出日志')
})

test('队员级专家：一次明确 slug 仅取该 persona，保留 locale、长度上限和服务 this', async () => {
  const { services, calls } = makeServices({
    experts: DEMO_EXPERTS,
    enabled: ['growth-hacker', 'data-analyst'],
    personas: { 'growth-hacker': 'You run growth experiments.', 'data-analyst': 'You read funnels.' },
  })
  delete services[AGENCY_SERVICE_KEYS.teams]
  const resolved = await resolveOptionalExpertPersona({ ctx: ctxWith(services), slug: '  growth-hacker  ', locale: '  en  ' })
  assert.deepEqual(resolved, { slug: 'growth-hacker', executionPrompt: 'You run growth experiments.' })
  assert.equal(calls.catalog, 1)
  assert.deepEqual(calls.getPrompt, [{ slug: 'growth-hacker', division: 'marketing', locale: 'en' }])
  assert.equal(calls.snapshot, 0)

  const stateful = ctxWith({
    [AGENCY_SERVICE_KEYS.library]: {
      snapshot: { experts: [{ slug: 'solo', division: 'ops' }], enabled: ['solo'] },
      catalog() { return this.snapshot },
    },
    [AGENCY_SERVICE_KEYS.persona]: {
      prompt: 'x'.repeat(PERSONA_MAX_CHARS + 3),
      getPrompt(slug, division, locale) {
        assert.deepEqual([slug, division, locale], ['solo', 'ops', DEFAULT_LOCALE])
        return { prompt: this.prompt }
      },
    },
  })
  const truncated = await resolveOptionalExpertPersona({ ctx: stateful, slug: 'solo', locale: '   ' })
  assert.deepEqual(truncated, { slug: 'solo', executionPrompt: 'x'.repeat(PERSONA_MAX_CHARS) })
})

test('队员级专家：只读清单只列已启用项，服务缺席时给出原因而不是抛错', async () => {
  // 队长要靠这份清单自己挑人（用户不必点名），所以它必须是只读、无副作用、
  // 且在没有 agency-agents 时安静回落。
  const { services } = makeServices({
    experts: DEMO_EXPERTS,
    enabled: ['data-analyst'],
    personas: { 'data-analyst': 'You read funnels.' },
  })
  const listed = await listEnabledExperts(ctxWith(services))
  assert.equal(listed.available, true)
  assert.deepEqual(listed.experts.map((expert) => expert.slug), ['data-analyst'], '只列已启用')

  const absent = await listEnabledExperts(ctxWith({}))
  assert.equal(absent.available, false)
  assert.match(absent.reason, /not registered/)

  const noCtx = await listEnabledExperts(undefined)
  assert.equal(noCtx.available, false)
})

test('队员级专家：单个队员按需挂 persona，未启用/不存在/缺正文都明确拒绝', async () => {
  // 「有适配的就用」——挂专家是队员级可选项，不是整团替换。
  const { services, calls } = makeServices({
    experts: DEMO_EXPERTS,
    enabled: ['growth-hacker', 'data-analyst'],
    personas: { 'growth-hacker': 'You run growth experiments.' },
  })
  const ctx = ctxWith(services)

  const ok = await resolveExpertPersona({ ctx, slug: 'growth-hacker', locale: DEFAULT_LOCALE })
  assert.equal(ok.ok, true)
  assert.equal(ok.slug, 'growth-hacker')
  assert.equal(ok.executionPrompt, 'You run growth experiments.')
  assert.deepEqual(calls.getPrompt, [{ slug: 'growth-hacker', division: 'marketing', locale: 'zh' }], 'division 必须按 catalog 传对')

  const unknown = await resolveExpertPersona({ ctx, slug: 'nobody', locale: DEFAULT_LOCALE })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /not in the agency catalog/)

  const { services: partiallyEnabled } = makeServices({ experts: DEMO_EXPERTS, enabled: ['data-analyst'] })
  const disabled = await resolveExpertPersona({ ctx: ctxWith(partiallyEnabled), slug: 'growth-hacker', locale: DEFAULT_LOCALE })
  assert.equal(disabled.ok, false)
  assert.match(disabled.error, /not enabled/)

  const noPersona = await resolveExpertPersona({ ctx, slug: 'data-analyst', locale: DEFAULT_LOCALE })
  assert.equal(noPersona.ok, false)
  assert.match(noPersona.error, /no persona text/)

  const empty = await resolveExpertPersona({ ctx, slug: '   ', locale: DEFAULT_LOCALE })
  assert.equal(empty.ok, false)

  const unavailable = await resolveExpertPersona({ ctx: undefined, slug: 'growth-hacker', locale: DEFAULT_LOCALE })
  assert.equal(unavailable.ok, false)
})
